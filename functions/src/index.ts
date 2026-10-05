/**
 * Family Hub X — Cloud Functions (TypeScript, Node 20).
 * Firebase Functions v2 with secrets.
 *
 * Callable functions:
 *   inviteMember           (admin invites adult with email)
 *   inviteChild            (admin invites child with username + kid binding)
 *   listMembers            (admin lists all members in hub)
 *   listKidsForInvite      (admin lists kids for binding dropdown)
 *   removeMember           (admin disables a member)
 *   changeRole             (admin changes member's role)
 *   resetMemberPassword    (admin generates reset link for a member)
 *
 * Required secrets (set via `firebase functions:secrets:set`):
 *   SMTP_PASS              Gmail app password for SMTP auth
 */

import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import nodemailer from "nodemailer";

// === Secrets ===
const SMTP_USER_SECRET = defineSecret("SMTP_USER");
const SMTP_PASS_SECRET = defineSecret("SMTP_PASS");

// === Region ===
setGlobalOptions({ region: "us-central1" });

// === Lazy admin init ===
if (getApps().length === 0) {
  initializeApp();
}

const auth = getAuth();
const db = getFirestore();
const APP_ID = "family-hub-v2";
const KIDS_EMAIL_DOMAIN = "@kids.fhx.app";

// === Capability sets ===
const ADMIN_CAPS = {
  can_edit_grocery: true,
  can_edit_meals: true,
  can_edit_kids: true,
  can_assign_roles: true,
  can_invite: true,
  can_remove_members: true,
  can_view_audit: true,
  can_edit_schedule_general_note: true,
  data_scope: "hub_wide",
};

const MEMBER_CAPS = {
  can_edit_grocery: true,
  can_edit_meals: false,
  can_edit_kids: false,
  can_assign_roles: false,
  can_invite: false,
  can_remove_members: false,
  can_view_audit: false,
  can_edit_schedule_general_note: false,
  data_scope: "hub_wide",
};

const CHILD_CAPS = {
  can_edit_grocery: false,
  can_edit_meals: false,
  can_edit_kids: false,
  can_assign_roles: false,
  can_invite: false,
  can_remove_members: false,
  can_view_audit: false,
  can_edit_schedule_general_note: true,
  data_scope: "own_kid_only",
};

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// === Email sender ===
async function sendInviteEmail(opts: {
  toEmail: string;
  toName: string;
  setupLink: string;
  inviterName: string;
  hubName: string;
}): Promise<void> {
  const user = process.env.SMTP_USER || "echoopenc@gmail.com";
  const pass = process.env.SMTP_PASS;
  if (!pass) {
    throw new Error("SMTP_PASS env var must be set");
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  const subject = `Welcome to ${opts.hubName} on Family Hub X`;
  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff8e7;color:#333;">
  <div style="text-align:center;padding:20px 0;">
    <h1 style="color:#92400e;margin:0;">Welcome to Family Hub X</h1>
    <p style="color:#78716c;font-size:14px;margin:8px 0 0;">${opts.hubName}</p>
  </div>
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:16px;padding:24px;margin:20px 0;">
    <p>Hi <strong>${opts.toName}</strong>,</p>
    <p>${opts.inviterName} invited you to join <strong>${opts.hubName}</strong> on Family Hub X.</p>
    <p>Set up your password to get started:</p>
    <p style="text-align:center;margin:32px 0;">
      <a href="${opts.setupLink}"
         style="background:#f59e0b;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:bold;display:inline-block;">
        Set Up My Account →
      </a>
    </p>
    <p style="font-size:12px;color:#a8a29e;">This link expires in 1 hour. If it expires, ask ${opts.inviterName} to resend.</p>
  </div>
  <p style="font-size:11px;color:#a8a29e;text-align:center;">Sent by Family Hub X · family-hub-x.web.app</p>
</body>
</html>`;

  await transporter.sendMail({
    from: `Family Hub X <${user}>`,
    to: opts.toEmail,
    subject,
    html,
  });
}

// === Helpers ===
function hubCol(hubKey: string, sub: string) {
  return db.collection("artifacts").doc(APP_ID).collection("public").doc("data")
    .collection("hubs").doc(hubKey).collection(sub);
}

function requireAdmin(req: CallableRequest): { uid: string; hubKey: string } {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in");
  }
  const claims = (req.auth.token as any) || {};
  if (claims.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin only");
  }
  if (claims.status !== "active") {
    throw new HttpsError("permission-denied", "Account not active");
  }
  if (!claims.hub_key) {
    throw new HttpsError("failed-precondition", "No hub_key claim");
  }
  return { uid: req.auth.uid, hubKey: claims.hub_key };
}

// === Helpers for createHub (grapheme-aware hub name validation) ===
function graphemeLength(s: string): number {
  // Use Intl.Segmenter if available (Node 16+, all modern browsers)
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment: (s: string) => Iterable<unknown> } }).Segmenter;
  if (Seg) {
    try {
      return Array.from(new Seg("zh", { granularity: "grapheme" }).segment(s)).length;
    } catch {
      /* fall through */
    }
  }
  return [...s].length; // fallback: code points (Array.from iterates by code point)
}

function normalizeHubName(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

async function audit(hubKey: string, actor: string, action: string, target: string, details?: Record<string, unknown>) {
  await hubCol(hubKey, "audit").add({
    actor, action, target,
    details: details || {},
    at: FieldValue.serverTimestamp(),
  });
}

// === Callable functions ===

export const inviteMember = onCall({ secrets: [SMTP_USER_SECRET, SMTP_PASS_SECRET] },
  async (req) => {
    const { uid: callerUid, hubKey } = requireAdmin(req);
    const data = req.data as { email?: string; display_name?: string; role?: string };
    const targetEmail = (data.email || "").trim();
    const displayName = (data.display_name || "").trim();
    const role = (data.role || "member").trim();

    if (!targetEmail || !targetEmail.includes("@")) {
      throw new HttpsError("invalid-argument", "Valid email required");
    }
    if (!displayName) {
      throw new HttpsError("invalid-argument", "display_name required");
    }
    if (role !== "admin" && role !== "member") {
      throw new HttpsError("invalid-argument", "role must be admin or member");
    }
    const caps = role === "admin" ? ADMIN_CAPS : MEMBER_CAPS;

    // === Global email uniqueness check (cross-hub) ===
    try {
      const existingByEmail = await auth.getUserByEmail(targetEmail);
      if (existingByEmail) {
        const existingClaims = (existingByEmail.customClaims as any) || {};
        if (existingClaims.hub_key && existingClaims.hub_key !== hubKey) {
          throw new HttpsError("already-exists", "email-already-registered-in-other-hub");
        }
        if (existingClaims.hub_key === hubKey) {
          // Same hub — already a member
          throw new HttpsError("already-exists", "email-already-in-this-hub");
        }
      }
    } catch (e: any) {
      if (e instanceof HttpsError) throw e;
      if (e.code !== "auth/user-not-found") {
        throw e;
      }
    }

    let user;
    let created = false;
    try {
      user = await auth.getUserByEmail(targetEmail);
    } catch (e: any) {
      if (e.code === "auth/user-not-found") {
        user = await auth.createUser({
          email: targetEmail,
          displayName,
          emailVerified: true,
        });
        created = true;
      } else {
        throw e;
      }
    }

    await auth.setCustomUserClaims(user.uid, {
      hub_key: hubKey, role, status: "active",
    });

    await db.collection("users").doc(user.uid).set({
      email: targetEmail, display_name: displayName,
      hub_key: hubKey, role, status: "active",
      last_active_at: FieldValue.serverTimestamp(),
    }, { merge: true });

    await hubCol(hubKey, "members").doc(user.uid).set({
      email: targetEmail, display_name: displayName,
      role, status: "active",
      auth_methods: ["password"], primary_method: "password",
      has_password: false, needs_password_setup: true,
      capabilities: caps,
      created_at: FieldValue.serverTimestamp(), created_by: callerUid,
    }, { merge: true });

    await audit(hubKey, callerUid, "member_invited", user.uid, {
      email: targetEmail, display_name: displayName, role,
    });

    const setupLink = await auth.generatePasswordResetLink(targetEmail);

    // Send invite email
    let emailSent = false;
    let emailError: string | undefined;
    try {
      const hubDoc = await db.collection("artifacts").doc(APP_ID).collection("public").doc("data")
        .collection("hubs").doc(hubKey).get();
      const hubName = (hubDoc.data()?.profile?.name) || hubKey;
      await sendInviteEmail({
        toEmail: targetEmail,
        toName: displayName,
        setupLink,
        inviterName: req.auth!.token.name as string || "Admin",
        hubName,
      });
      emailSent = true;
    } catch (e: any) {
      emailError = e.message;
      console.error("Email send failed:", e);
    }

    return {
      ok: true, uid: user.uid, email: targetEmail,
      display_name: displayName, role, created,
      setup_link: setupLink, email_sent: emailSent,
      email_error: emailError,
    };
  }
);

export const inviteChild = onCall({ secrets: [SMTP_USER_SECRET, SMTP_PASS_SECRET] },
  async (req) => {
    const { uid: callerUid, hubKey } = requireAdmin(req);
    const data = req.data as { username?: string; display_name?: string; bound_kid_id?: string };
    const username = (data.username || "").trim().toLowerCase();
    const displayName = (data.display_name || "").trim();
    const boundKidId = (data.bound_kid_id || "").trim();

    if (!USERNAME_RE.test(username)) {
      throw new HttpsError("invalid-argument", "Invalid username (3-20 chars, lowercase letters/digits/underscore)");
    }
    if (!displayName) {
      throw new HttpsError("invalid-argument", "display_name required");
    }
    if (!boundKidId) {
      throw new HttpsError("invalid-argument", "bound_kid_id required");
    }

    const kidSnap = await hubCol(hubKey, "kids").doc(boundKidId).get();
    if (!kidSnap.exists) {
      throw new HttpsError("not-found", `Kid ${boundKidId} not found`);
    }
    const kidName = kidSnap.data()?.name || "?";

    const syntheticEmail = `${username}${KIDS_EMAIL_DOMAIN}`;
    let user;
    let created = false;
    try {
      user = await auth.getUserByEmail(syntheticEmail);
    } catch (e: any) {
      if (e.code === "auth/user-not-found") {
        user = await auth.createUser({
          email: syntheticEmail,
          displayName,
          emailVerified: true,
        });
        created = true;
      } else {
        throw e;
      }
    }

    await auth.setCustomUserClaims(user.uid, {
      hub_key: hubKey, role: "child", status: "active",
      bound_kid_id: boundKidId,
    });

    await db.collection("users").doc(user.uid).set({
      email: null, synthetic_email: syntheticEmail,
      username, display_name: displayName,
      hub_key: hubKey, role: "child", status: "active",
      bound_kid_id: boundKidId,
      last_active_at: FieldValue.serverTimestamp(),
    }, { merge: true });

    await hubCol(hubKey, "members").doc(user.uid).set({
      email: null, synthetic_email: syntheticEmail,
      username, display_name: displayName,
      role: "child", status: "active",
      auth_methods: ["password"], primary_method: "password",
      has_password: false, needs_password_setup: true,
      capabilities: CHILD_CAPS,
      bound_kid_id: boundKidId,
      created_at: FieldValue.serverTimestamp(), created_by: callerUid,
    }, { merge: true });

    await audit(hubKey, callerUid, "child_invited", user.uid, {
      username, display_name: displayName,
      bound_kid_id: boundKidId, kid_name: kidName,
    });

    const setupLink = await auth.generatePasswordResetLink(syntheticEmail);

    let emailSent = false;
    let emailError: string | undefined;
    try {
      const hubDoc = await db.collection("artifacts").doc(APP_ID).collection("public").doc("data")
        .collection("hubs").doc(hubKey).get();
      const hubName = (hubDoc.data()?.profile?.name) || hubKey;
      await sendInviteEmail({
        toEmail: syntheticEmail,
        toName: displayName,
        setupLink,
        inviterName: req.auth!.token.name as string || "Family",
        hubName,
      });
      emailSent = true;
    } catch (e: any) {
      emailError = e.message;
      console.error("Email send failed:", e);
    }

    return {
      ok: true, uid: user.uid, username,
      kid_name: kidName, bound_kid_id: boundKidId, created,
      setup_link: setupLink, email_sent: emailSent,
      email_error: emailError,
    };
  }
);

export const listMembers = onCall(async (req) => {
  const { hubKey } = requireAdmin(req);
  const snap = await hubCol(hubKey, "members").get();
  const members = snap.docs.map(d => {
    const x = d.data();
    return {
      uid: d.id,
      display_name: x.display_name,
      email: x.email || x.synthetic_email,
      role: x.role,
      status: x.status,
      username: x.username,
      bound_kid_id: x.bound_kid_id,
      needs_password_setup: x.needs_password_setup || false,
    };
  });
  return { members, hub_key: hubKey };
});

export const listKidsForInvite = onCall(async (req) => {
  const { hubKey } = requireAdmin(req);
  const snap = await hubCol(hubKey, "kids").get();
  const kids = snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, name: x.name, grade: x.grade, className: x.className };
  });
  return { kids };
});

export const removeMember = onCall(async (req) => {
  const { uid: callerUid, hubKey } = requireAdmin(req);
  const data = req.data as { uid?: string };
  const targetUid = (data.uid || "").trim();
  if (!targetUid) {
    throw new HttpsError("invalid-argument", "uid required");
  }

  if (targetUid === callerUid) {
    const admins = await hubCol(hubKey, "members")
      .where("role", "==", "admin").where("status", "==", "active").get();
    if (admins.size <= 1) {
      throw new HttpsError("failed-precondition", "Cannot disable the last admin");
    }
  }

  await hubCol(hubKey, "members").doc(targetUid).update({
    status: "disabled",
    disabled_at: FieldValue.serverTimestamp(),
    disabled_by: callerUid,
  });
  try {
    await auth.setCustomUserClaims(targetUid, { hub_key: hubKey, status: "disabled" });
  } catch (e) {
    // user might not exist
  }

  await audit(hubKey, callerUid, "member_removed", targetUid);
  return { ok: true, uid: targetUid, status: "disabled" };
});

export const changeRole = onCall(async (req) => {
  const { uid: callerUid, hubKey } = requireAdmin(req);
  const data = req.data as { uid?: string; new_role?: string };
  const targetUid = (data.uid || "").trim();
  const newRole = (data.new_role || "").trim();

  if (!targetUid || !["admin", "member", "child"].includes(newRole)) {
    throw new HttpsError("invalid-argument", "uid + new_role(admin|member|child) required");
  }
  if (newRole === "child") {
    throw new HttpsError("failed-precondition", "Use inviteChild for child role");
  }

  const targetDoc = await hubCol(hubKey, "members").doc(targetUid).get();
  if (!targetDoc.exists) {
    throw new HttpsError("not-found", "Member not found");
  }
  const targetData = targetDoc.data()!;
  const currentRole = targetData.role;

  if (targetUid === callerUid && currentRole === "admin" && newRole !== "admin") {
    const admins = await hubCol(hubKey, "members")
      .where("role", "==", "admin").where("status", "==", "active").get();
    if (admins.size <= 1) {
      throw new HttpsError("failed-precondition", "Cannot demote the last admin");
    }
  }

  const caps = newRole === "admin" ? ADMIN_CAPS : MEMBER_CAPS;
  await auth.setCustomUserClaims(targetUid, {
    hub_key: hubKey, role: newRole, status: "active",
  });
  await hubCol(hubKey, "members").doc(targetUid).update({
    role: newRole, capabilities: caps,
  });
  await audit(hubKey, callerUid, "role_changed", targetUid, {
    from: currentRole, to: newRole,
  });

  return { ok: true, uid: targetUid, role: newRole };
});

export const resetMemberPassword = onCall({ secrets: [SMTP_USER_SECRET, SMTP_PASS_SECRET] },
  async (req) => {
    const { uid: callerUid, hubKey } = requireAdmin(req);
    const data = req.data as { uid?: string };
    const targetUid = (data.uid || "").trim();
    if (!targetUid) {
      throw new HttpsError("invalid-argument", "uid required");
    }

    const memberDoc = await hubCol(hubKey, "members").doc(targetUid).get();
    if (!memberDoc.exists) {
      throw new HttpsError("not-found", "Member not found");
    }
    const md = memberDoc.data()!;
    const targetEmail = md.email || md.synthetic_email;
    if (!targetEmail) {
      throw new HttpsError("failed-precondition", "No email on file");
    }

    const resetLink = await auth.generatePasswordResetLink(targetEmail);
    await hubCol(hubKey, "members").doc(targetUid).update({
      last_password_change_at: FieldValue.serverTimestamp(),
      needs_password_setup: true,
    });
    await audit(hubKey, callerUid, "password_reset_initiated", targetUid);

    let emailSent = false;
    let emailError: string | undefined;
    try {
      const hubDoc = await db.collection("artifacts").doc(APP_ID).collection("public").doc("data")
        .collection("hubs").doc(hubKey).get();
      const hubName = (hubDoc.data()?.profile?.name) || hubKey;
      await sendInviteEmail({
        toEmail: targetEmail,
        toName: md.display_name || targetEmail,
        setupLink: resetLink,
        inviterName: req.auth!.token.name as string || "Admin",
        hubName,
      });
      emailSent = true;
    } catch (e: any) {
      emailError = e.message;
    }

    return {
      ok: true, uid: targetUid, email: targetEmail,
      setup_link: resetLink, email_sent: emailSent,
      email_error: emailError,
    };
  }
);

// === Callable: createHub ===
// Bootstrap a new hub for a signed-in user who has no hub_key claim yet.
// Client is responsible for sign-in/sign-up first (Firebase Auth).
// Input: { hubName } — email is taken from req.auth.token.email.
// Validates: hub name length (2-20 grapheme clusters), global email uniqueness (cross-check
//            via auth.getUserByEmail), global hub name uniqueness (NFC normalized).
// Creates: hub doc, members/{uid} (admin), users/{uid} mirror, custom claims, audit log.
// Returns: { ok, hubKey, hubName } so client can refresh token and re-enter app.
export const createHub = onCall(async (req) => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "must-be-signed-in");
  }
  const claims = (req.auth.token as any) || {};
  if (claims.hub_key) {
    throw new HttpsError("already-exists", "already-linked-to-hub");
  }

  const data = req.data as { hubName?: string };
  const hubName = (data.hubName || "").trim();
  const email = (req.auth.token.email || "").toLowerCase();

  // Hub name: 2-20 grapheme clusters (CJK + emoji + ZWJ family combos all count as 1)
  if (!hubName) {
    throw new HttpsError("invalid-argument", "hub-name-required");
  }
  const nameLen = graphemeLength(hubName);
  if (nameLen < 2 || nameLen > 20) {
    throw new HttpsError("invalid-argument", "hub-name-length-2-20");
  }
  // Email must exist on the auth user (we just verified sign-in)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("failed-precondition", "no-email-on-auth-user");
  }

  const uid = req.auth.uid;

  // === Global hub name uniqueness check ===
  // Scan all hub docs (project is small, no scale issue yet). If too many hubs, add `hubNameIndex` collection.
  const hubsSnap = await db.collection("artifacts").doc(APP_ID).collection("public")
    .doc("data").collection("hubs").get();
  const normalized = normalizeHubName(hubName);
  for (const docSnap of hubsSnap.docs) {
    const existingName = ((docSnap.data()?.profile?.name) || "")
      .normalize("NFC").trim().toLowerCase();
    if (existingName === normalized) {
      throw new HttpsError("already-exists", "hub-name-taken");
    }
  }

  // === Derive hub key from auth uid (guaranteed unique, never collides) ===
  const hubKey = `hub-${uid}`;
  const displayName = email.split("@")[0];

  // === Update displayName (email already set, password already set on auth user from sign-up) ===
  try {
    await auth.updateUser(uid, {
      displayName,
      emailVerified: true,
    });
  } catch (e: any) {
    throw new HttpsError("internal", "auth-update-failed: " + (e.message || "unknown"));
  }

  const hubRef = db.collection("artifacts").doc(APP_ID).collection("public")
    .doc("data").collection("hubs").doc(hubKey);

  // === Create hub root doc ===
  await hubRef.set({
    profile: {
      name: hubName,
      created_at: FieldValue.serverTimestamp(),
    },
    created_by: uid,
    created_at: FieldValue.serverTimestamp(),
  });

  // === Add self to members/{uid} as admin ===
  await hubRef.collection("members").doc(uid).set({
    email,
    display_name: displayName,
    role: "admin",
    status: "active",
    auth_methods: ["password"],
    primary_method: "password",
    has_password: true,
    needs_password_setup: false,
    capabilities: ADMIN_CAPS,
    created_at: FieldValue.serverTimestamp(),
    created_by: uid,
  });

  // === Mirror to top-level users/{uid} ===
  await db.collection("users").doc(uid).set({
    email,
    display_name: displayName,
    hub_key: hubKey,
    role: "admin",
    status: "active",
    last_active_at: FieldValue.serverTimestamp(),
  }, { merge: true });

  // === Custom claims ===
  await auth.setCustomUserClaims(uid, {
    hub_key: hubKey, role: "admin", status: "active",
  });

  // Audit log
  await hubRef.collection("audit").add({
    actor: uid, action: "hub_created", target: hubKey,
    details: { hub_name: hubName },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true, hubKey, hubName };
});

// === Callable: checkEmailExists ===
// Pre-check before "Create new Hub" submission. Returns { exists: bool }.
// Uses Admin SDK auth.getUserByEmail which throws auth/user-not-found if absent.
export const checkEmailExists = onCall(async (req) => {
  const data = req.data as { email?: string };
  const email = (data.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "email-invalid");
  }
  try {
    const user = await auth.getUserByEmail(email);
    return { exists: true, uid: user.uid };
  } catch (e: any) {
    if (e.code === "auth/user-not-found") {
      return { exists: false };
    }
    throw new HttpsError("internal", "email-check-failed: " + (e.message || "unknown"));
  }
});
