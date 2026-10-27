// helm-notices.mjs - Helm's own notices queued by migration 0244 (helm_notice_outbox), handed out by
// helm_notice_outbox_claim with the recipients resolved in the database (never taken from a row):
//   sales_request  a studio admin pressed "Contact sales" on /checkout or the read-only banner
//                  -> sales@helm.events (plain text, every detail one line each)
//   upgrade_ask    a teammate pressed "Ask my admin to upgrade" -> the studio's admins
//   close_request  (0254) a teammate asked to close an event with checks still open -> the studio's admins,
//                  coordinators and managers (not the requester)
//   close_decision (0254) the request was approved (event closed) or declined -> the requester
//   studio_identity (0257) Helm HQ changed the studio's name and/or link -> the studio's admins
//   inbox_digest   (0266) a person's still-unread inbox items (daily digest or instant important) -> that person
//   sales_enquiry  (0271) someone filled in the public Contact sales form -> the HQ address (default notifications@helm.events)
//   sales_enquiry_ack (0271) the automatic thank-you -> the person who filled it in (once a day per address)
//   suggestion     (0271) someone sent a suggestion (in the app or on the website) -> the HQ address
//   hq_staff       (0277) a Helm HQ team change (added, role changed, paused, access back, removed, signed out
//                  everywhere, sign-in rules) -> the person it is about + every HQ Owner
//   team_safety    (0283) a studio team change: an admin will be deactivated / changed in 24 hours (asked by an
//                  admin who is not the owner), cancelled, done, done at once by the owner -> the owner + that admin +
//                  the asker; a studio ownership hand-over / acceptance / cancel / decline, or Helm support recovered the
//                  owner -> every active admin of the studio
// Pure (no I/O); shared by comms-dispatch (Deno) and the node tests. Anything unexpected -> null and
// comms-dispatch marks the row skipped (fails closed). Links are always APP_URL + a fixed path.
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const block = (v, n) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
const base = (app) => String(app || "https://www.helm.events").replace(/\/+$/, "");

export const NOTICE_KINDS = ["sales_request", "upgrade_ask", "close_request", "close_decision", "studio_identity", "inbox_digest", "sales_enquiry", "sales_enquiry_ack", "suggestion", "hq_staff", "team_safety"];
// the footer reason for each kind (transactional: a service message about this account)
export const NOTICE_TX_REASON = {
  sales_request: "a Helm studio asked Helm sales to activate a plan",
  upgrade_ask: "a teammate in your Helm studio asked you to choose a plan",
  close_request: "a teammate in your Helm studio asked to close an event and you can approve it",
  close_decision: "you asked to close an event in your Helm studio",
  studio_identity: "you are an admin of a Helm studio whose name or link was changed by Helm support",
  inbox_digest: "you have unread notifications in your Helm inbox (change how often on your Inbox page)",
  sales_enquiry: "someone filled in the Contact sales form on the Helm website",
  sales_enquiry_ack: "you filled in the Contact sales form on the Helm website",
  suggestion: "someone sent a suggestion to Helm",
  hq_staff: "you are on the Helm HQ team, or this change is about your Helm HQ access",
  team_safety: "you are an admin of a Helm studio, or this change is about your access to it",
};
const PLAN_NAME = { starter: "Starter", studio: "Studio", enterprise: "Enterprise", not_sure: "Not sure yet" };
const TEAM = { "1": "Just me", "2-5": "2-5 people", "6-15": "6-15 people", "16-50": "16-50 people", "51+": "51+ people" };
const SLUG = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const closureLink = (app, q) => app + "/closure.html?quote=" + String(q).toLowerCase() + "#close-request";

export function helmNoticeEmail(kind, data, appUrl) {
  const d = data && typeof data === "object" ? data : {};
  const app = base(appUrl);
  if (kind === "sales_request") {
    const studio = clip(d.studio, 160), plan = clip(d.plan, 80), email = clip(d.email, 200);
    if (!studio || !plan || !email) return null;
    const iv = d.interval === "yearly" ? "Yearly" : "Monthly";
    const lines = [
      "New plan request from Helm" + (d.source === "read_only_banner" ? " (read-only banner)" : " (plan page)") + ".",
      "",
      "Studio: " + studio + (clip(d.account, 160) && clip(d.account, 160) !== studio ? " (account: " + clip(d.account, 160) + ")" : ""),
      "Name: " + (clip(d.name, 80) || "-"),
      "Email: " + email,
      "Phone: " + (clip(d.phone, 20) || "-"),
      "Plan: " + plan,
      "Billing: " + iv,
      "Subscription now: " + (clip(d.subscription_status, 20) || "-"),
      "",
      "Message:",
      block(d.message, 1000) || "-",
      "",
      "Open HQ -> Requests to mark it contacted, then HQ -> Studios -> Activate plan once paid.",
    ];
    return { subject: "Helm plan request: " + plan + " (" + iv + ") - " + studio.slice(0, 80), text: lines.join("\n") };
  }
  if (kind === "upgrade_ask") {
    const who = clip(d.who, 80) || "A teammate";
    const studio = clip(d.studio, 160);
    return {
      subject: who + " asked you to choose a Helm plan",
      text: [
        "Hi,",
        who + " in " + (studio || "your Helm studio") + " asked you to choose a Helm plan, so the team can keep creating and editing.",
        "Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.",
        "Choose a plan: " + app + "/checkout",
        "- The Helm team",
      ].join("\n\n"),
    };
  }
  if (kind === "close_request" || kind === "close_decision") {
    if (!UUID.test(String(d.quote_id || ""))) return null;
    const ev = clip(d.event, 120) || "Event", code = clip(d.code, 40), date = clip(d.event_date, 10);
    const label = ev + (code ? " (" + code + ")" : "") + (date ? " - " + date : "");
    const who = clip(d.requested_name, 80) || "A teammate", reason = block(d.reason, 1000);
    const open = (Array.isArray(d.failed) ? d.failed : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 12);
    const link = closureLink(app, d.quote_id);
    if (kind === "close_request") {
      if (!reason) return null;
      return {
        subject: "Close request: " + label.slice(0, 120) + " - waiting for your approval",
        text: [
          "Hi,",
          who + " asked to close " + label + (clip(d.studio, 160) ? " in " + clip(d.studio, 160) : "") + " while some checks are still open.",
          "Still open:\n" + (open.length ? open.map((x) => "- " + x).join("\n") : "-"),
          "Reason:\n" + reason,
          "Approve (the event closes) or decline with a note on the Closure page: " + link,
          "- The Helm team",
        ].join("\n\n"),
      };
    }
    const by = clip(d.decided_name, 80) || "An approver", note = block(d.note, 1000);
    if (d.status === "approved") {
      return {
        subject: "Close request approved: " + label.slice(0, 120) + " is closed",
        text: ["Hi,", by + " approved your request to close " + label + ". The event is now closed and archived.",
          note ? "Note:\n" + note : "", "Closure page: " + link, "- The Helm team"].filter(Boolean).join("\n\n"),
      };
    }
    if (d.status === "declined") {
      return {
        subject: "Close request declined: " + label.slice(0, 120),
        text: ["Hi,", by + " declined your request to close " + label + ".", "Why:\n" + (note || "-"),
          "Fix the open checks or send a new request on the Closure page: " + link, "- The Helm team"].join("\n\n"),
      };
    }
    return null;
  }
  if (kind === "studio_identity") {
    // r23 (0257): Helm HQ changed the studio name and/or link; old links keep working
    const nf = clip(d.name_from, 120), nt = clip(d.name_to, 120), lf = clip(d.link_from, 60), lt = clip(d.link_to, 60);
    if (!nt || !SLUG.test(lt) || (lf && !SLUG.test(lf))) return null;
    const nameChanged = !!nf && nf !== nt, linkChanged = !!lf && lf !== lt;
    if (!nameChanged && !linkChanged) return null;
    const host = app.replace(/^https?:\/\/(www\.)?/, "");
    return {
      subject: "Helm support changed your studio " + (nameChanged && linkChanged ? "name and link" : nameChanged ? "name" : "link"),
      text: [
        "Hi,",
        "Helm support changed your studio on Helm, as requested.",
        nameChanged ? "Studio name: " + nf + " -> " + nt : "",
        linkChanged ? "Studio link: " + host + "/" + lf + " -> " + host + "/" + lt : "",
        linkChanged ? "Links you already sent (quotes, portals, booklets, invitations, crew links) keep working and open under the new link." : "",
        "If you did not ask for this, reply to this e-mail or write to support@helm.events straight away.",
        "Open your studio: " + app + "/" + lt + "/dashboard",
        "- The Helm team",
      ].filter(Boolean).join("\n\n"),
    };
  }
  if (kind === "inbox_digest") {
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 20).map((x) => {
      const t = clip(x && x.title, 140); if (!t) return "";
      const ev = [clip(x.code, 40), clip(x.event, 120)].filter(Boolean).join(" · ");
      return "- " + t + (ev ? " (" + ev + ")" : "") + (clip(x.at, 24) ? " - " + clip(x.at, 24) : "");
    }).filter(Boolean);
    if (!items.length) return null;
    const instant = d.mode === "instant_important", more = Math.max(0, Number(d.more) || 0), studio = clip(d.studio, 160);
    const n = items.length;
    return {
      subject: instant ? "Helm: " + (n === 1 ? items[0].slice(2, 110) : n + " important updates") + (studio ? " - " + studio.slice(0, 60) : "")
                       : "Helm: " + n + " unread notification" + (n === 1 ? "" : "s") + (studio ? " in " + studio.slice(0, 60) : ""),
      text: [
        "Hi" + (clip(d.name, 40) ? " " + clip(d.name, 40) : "") + ",",
        (instant ? "Something important is waiting in your Helm inbox:" : "Still unread in your Helm inbox:") + "\n" + items.join("\n"),
        more ? "And " + more + " more unread in your inbox." : "",
        "Open your inbox: " + app + "/inbox",
        "Change how often Helm e-mails you (daily, instant for important items, or never): " + app + "/inbox#settings",
        "- The Helm team",
      ].filter(Boolean).join("\n\n"),
    };
  }
  if (kind === "sales_enquiry") {
    // r24 (0271): the public Contact sales form -> the HQ address; replying goes to the sender
    const name = clip(d.name, 80), email = clip(d.email, 200), company = clip(d.company, 160);
    if (!name || !company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    const plan = PLAN_NAME[d.plan] || "-";
    const lines = [
      "New sales enquiry from the Helm website" + (d.source === "home" ? " (home page)" : " (Contact sales page)") + ".",
      "",
      "Name: " + name,
      "Work e-mail: " + email,
      "Phone: " + (clip(d.phone, 20) || "-"),
      "Company / studio: " + company,
      "City: " + (clip(d.city, 80) || "-"),
      "Team size: " + (TEAM[d.team_size] || "-"),
      "Events per year: " + (clip(d.events_per_year, 10) || "-"),
      "Plan: " + plan,
      "",
      "Message:",
      block(d.message, 2000) || "-",
      "",
      "Reply to this e-mail to answer " + name + ". Mark it in Helm HQ -> Requests -> Sales enquiries: " + app + "/hq#requests",
    ];
    return { subject: "Sales enquiry: " + company.slice(0, 80) + (plan !== "-" ? " (" + plan + ")" : ""), text: lines.join("\n") };
  }
  if (kind === "suggestion") {
    // r24 (0271): the suggestions box -> the HQ address; replying goes to the sender when we know their e-mail
    const msg = block(d.message, 2000);
    if (!msg) return null;
    const cat = { idea: "Idea", problem: "Problem", other: "Other" }[d.category] || "-";
    const who = clip(d.who, 80), studio = clip(d.studio, 160), email = clip(d.email, 200);
    return {
      subject: "Helm suggestion" + (cat !== "-" ? " (" + cat + ")" : "") + ": " + clip(d.message, 60),
      text: [
        "New suggestion " + (d.source === "app" ? "from inside the app" : "from the Helm website") + ".",
        "",
        "Kind: " + cat,
        "From: " + (who || (d.source === "app" ? "a Helm user" : "a visitor")) + (studio ? " (" + studio + ")" : ""),
        "E-mail: " + (email || "-"),
        "Page: " + (clip(d.page, 120) || "-"),
        "",
        "Suggestion:",
        msg,
        "",
        "Mark it in Helm HQ -> Requests -> Suggestions: " + app + "/hq#requests",
      ].join("\n"),
    };
  }
  if (kind === "hq_staff") {
    // r27 (0277): one neutral text for the person AND the Owners (both get the same e-mail)
    const email = clip(d.email, 200), role = clip(d.role, 20), by = clip(d.by, 200), reason = clip(d.reason, 300);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    const who = by ? " by " + by : "";
    const S = {
      invited: ["Helm HQ: " + email + " was added as " + (role || "staff"), email + " was added to Helm HQ as " + (role || "staff") + who + ".",
        ["How to start (for " + email + "):",
         "1. Open " + app + "/login",
         "2. Use exactly " + email + ": \"Continue with Google\" if it is a Google account, otherwise sign up with this e-mail and a password (then confirm the e-mail Helm sends).",
         "3. Set up two-step verification when Helm asks (an authenticator app such as Google Authenticator). It is required for Helm HQ.",
         "4. Helm HQ opens with only what the " + (role || "staff") + " role allows."].join("\n")],
      role_changed: ["Helm HQ: " + email + " is now " + (role || "-"), "The Helm HQ role of " + email + " changed" + (d.old_role ? " from " + clip(d.old_role, 20) : "") + " to " + (role || "-") + who + ".", "It applies at once."],
      suspended: ["Helm HQ: access paused for " + email, "Helm HQ access for " + email + " was paused" + who + ". All HQ sign-ins were ended.", reason ? "Reason: " + reason : ""],
      restored: ["Helm HQ: access back for " + email, "Helm HQ access for " + email + " was given back" + who + ".", "Sign in again at " + app + "/login (two-step is required)."],
      removed: ["Helm HQ: " + email + " was removed", email + " was removed from Helm HQ" + who + ". Nothing was deleted; an Owner can add them back.", reason ? "Reason: " + reason : ""],
      signed_out: ["Helm HQ: " + email + " was signed out everywhere", email + " was signed out of Helm HQ on every device" + who + ".", "If this was not expected, tell the Helm HQ owner."],
      settings: ["Helm HQ: sign-in rules changed", "The Helm HQ sign-in rules (idle time, longest sign-in, fresh code, IP allowlist) were changed" + who + ".", "See Helm HQ -> Staff access."],
    }[d.event];
    if (!S) return null;
    return { subject: S[0].slice(0, 150), text: [S[1], S[2], "Helm HQ -> Staff access: " + app + "/hq", "If you did not expect this, reply to this e-mail or contact security@helm.events.", "- The Helm team"].filter(Boolean).join("\n\n") };
  }
  if (kind === "team_safety") {
    // r33 (0283): names only (no e-mail addresses of others, no links but Control Center -> Team on APP_URL)
    const studio = clip(d.studio, 120) || "your Helm studio", target = clip(d.target, 80) || "An admin", by = clip(d.by, 80) || "An admin";
    const role = clip(d.role_label, 40) || "a non-admin role", when = clip(d.when, 60), from = clip(d.from, 80) || "The owner", to = clip(d.to, 80) || "an admin";
    const deact = d.kind === "deactivate";
    const team = "Control Center -> Team: " + app + "/control#users";
    const S = {
      admin_change_requested: [
        "Helm: " + target + (deact ? " will be deactivated" : " will become " + role) + " in 24 hours - " + studio,
        by + " asked to " + (deact ? "deactivate " + target + " in " + studio + "." : "change " + target + "'s role in " + studio + " from Admin to " + role + ".")
          + " It happens " + (when ? "on " + when : "in 24 hours") + " unless the studio owner cancels it.",
        "The studio owner can cancel it in " + team],
      admin_change_cancelled: ["Helm: the change for " + target + " was cancelled - " + studio,
        by + " cancelled the waiting change for " + target + " in " + studio + ". Nothing was changed.", team],
      admin_change_applied: ["Helm: " + target + (deact ? " was deactivated" : " is now " + role) + " - " + studio,
        deact ? target + " was deactivated in " + studio + " (asked by " + by + " 24 hours ago). Their records are kept; an admin can reactivate them."
              : target + " is now " + role + " in " + studio + " (asked by " + by + " 24 hours ago).", team],
      admin_deactivated: ["Helm: " + target + " was deactivated - " + studio,
        by + " (the studio owner) deactivated " + target + " in " + studio + ". Their records are kept; an admin can reactivate them.", team],
      admin_demoted: ["Helm: " + target + " is now " + role + " - " + studio,
        by + " (the studio owner) changed " + target + "'s role in " + studio + " from Admin to " + role + ".", team],
      owner_transfer_started: ["Helm: " + from + " wants to make " + to + " the owner of " + studio,
        from + " started handing the ownership of " + studio + " to " + to + ". " + to + " must accept it in Control Center -> Team within 7 days.", team],
      owner_transfer_accepted: ["Helm: " + to + " is now the owner of " + studio,
        to + " accepted and is now the owner of " + studio + " (handed over by " + from + "). " + from + " stays an admin.", team],
      owner_transfer_cancelled: ["Helm: the ownership hand-over was cancelled - " + studio,
        from + " cancelled handing the ownership of " + studio + " to " + to + ". Nothing changed.", team],
      owner_transfer_declined: ["Helm: " + to + " declined to become the owner of " + studio,
        to + " declined to become the owner of " + studio + ". " + from + " stays the owner.", team],
      owner_recovered: ["Helm: Helm support made " + to + " the owner of " + studio,
        "Helm support made " + to + " the owner of " + studio + ", after checking who asked. The previous owner was no longer able to act for the studio.",
        "If this is not what your studio asked for, write to security@helm.events straight away."],
    }[d.event];
    if (!S) return null;
    return { subject: S[0].slice(0, 150), text: ["Hi,", S[1], S[2], "If you did not expect this, contact your studio owner or reply to this e-mail.", "- The Helm team"].join("\n\n") };
  }
  if (kind === "sales_enquiry_ack") {
    const name = clip(d.name, 80);
    const plan = PLAN_NAME[d.plan];
    return {
      subject: "Thanks for contacting Helm",
      text: [
        "Hi " + (name || "there") + ",",
        "Thank you for writing to Helm" + (plan && d.plan !== "not_sure" ? " about the " + plan + " plan" : "") + ". We have your message and our team will get back to you within one working day.",
        "In the meantime you can try Helm free for 8 days: " + app + "/signup?mode=trial",
        "- The Helm team",
      ].join("\n\n"),
    };
  }
  return null;
}
