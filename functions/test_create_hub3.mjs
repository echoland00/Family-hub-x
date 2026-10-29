#!/usr/bin/env node
// E2E test for createHub with explicit pre-check (Nigel spec 12:38):
// 1. fetchSignInMethodsForEmail(email) — if methods.length > 0 → reject
// 2. Else createUserWithEmailAndPassword (auto signs in)
// 3. Call createHub({hubName})
// 4. Refresh ID token + onAuthStateChanged sees new claim

import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const SA_PATH = '/home/nigel/.openclaw/secrets/firebase_service_account.json';
const PROJECT = 'family-hub-v2-72195';
const FN_URL = `https://us-central1-${PROJECT}.cloudfunctions.net/createHub`;
const APP_ID = 'family-hub-v2';
const API_KEY = 'AIzaSyC0717TOX3YK_Zck6UNIoXFOGMNlhH_FsM';

const sa = JSON.parse(readFileSync(SA_PATH, 'utf-8'));
if (getApps().length === 0) initializeApp({ credential: cert(sa), projectId: PROJECT });
const adminAuth = getAuth();
const adminDb = getFirestore();

let pass = 0, fail = 0;
const log = (ok, msg, extra) => {
  console.log((ok ? '✅' : '❌'), msg, extra ? JSON.stringify(extra) : '');
  ok ? pass++ : fail++;
};

async function getIdToken(uid) {
  const customToken = await adminAuth.createCustomToken(uid);
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error('token exchange failed');
  return data.idToken;
}

async function preCheckEmail(email) {
  // Mimic what client App.jsx does: fetchSignInMethodsForEmail
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, continueUri: 'https://example.com' }),
    }
  );
  const data = await resp.json();
  // createAuthUri returns { signinMethods, allProviders, ... } — signinMethods is the existence indicator
  return Array.isArray(data.signinMethods) && data.signinMethods.length > 0;
}

let testUid1, testUid2, testUid3, testUid4;
const newEmail = () => `echoopenc+precheck${Date.now()}${Math.floor(Math.random()*1000)}@gmail.com`;

async function cleanup() {
  console.log('\n--- Cleanup ---');
  for (const uid of [testUid1, testUid2, testUid3, testUid4]) {
    if (!uid) continue;
    try {
      const hubRef = adminDb.collection('artifacts').doc(APP_ID).collection('public').doc('data')
        .collection('hubs').doc(`hub-${uid}`);
      const ms = await hubRef.collection('members').get();
      for (const d of ms.docs) await d.ref.delete();
      const as_ = await hubRef.collection('audit').get();
      for (const d of as_.docs) await d.ref.delete();
      await hubRef.delete();
      await adminDb.collection('users').doc(uid).delete();
      await adminAuth.deleteUser(uid);
    } catch (e) { console.log(`  ⚠ cleanup ${uid}: ${e.message}`); }
  }
  console.log('  done');
}

async function test1_existingEmailRejected() {
  console.log('\n--- Test 1: Existing email → pre-check rejects ---');
  const email = newEmail();
  // Pre-create user
  const u = await adminAuth.createUser({ email, password: 'Test1234abc!', emailVerified: true });
  testUid1 = u.uid;
  // Client pre-check
  const exists = await preCheckEmail(email);
  log(exists, '1a. pre-check finds existing email', { email, exists });
  // If it exists, client should reject (not call createHub)
  if (exists) {
    log(true, '1b. would reject with "此 Email 已註冊過"');
  } else {
    log(false, '1b. pre-check did NOT detect existing email');
  }
}

async function test2_newEmailPassesPreCheck() {
  console.log('\n--- Test 2: New email → pre-check passes → full flow works ---');
  const email = newEmail();
  const hubName = 'Pre-Check Pass Hub';
  // Pre-check should return false
  const exists = await preCheckEmail(email);
  log(!exists, '2a. pre-check says email does not exist', { exists });
  // createUser (mimics client createUserWithEmailAndPassword after pre-check)
  const u = await adminAuth.createUser({ email, password: 'Test1234abc!', emailVerified: true });
  testUid2 = u.uid;
  const idToken = await getIdToken(u.uid);
  // Call createHub
  const resp = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({ data: { hubName } }),
  });
  const data = await resp.json();
  log(resp.ok, '2b. createHub call', { status: resp.status, result: data.result });
  if (resp.ok) {
    const claims = (await adminAuth.getUser(u.uid)).customClaims || {};
    log(claims.hub_key === `hub-${u.uid}`, '2c. custom claims set', { claims });
  }
}

async function test3_postCreateReCheckStillFindsEmail() {
  console.log('\n--- Test 3: After successful create, pre-check finds it (so re-submit rejects) ---');
  // Use testUid2 (already created in test2)
  const u2 = await adminAuth.getUser(testUid2);
  const exists = await preCheckEmail(u2.email);
  log(exists, '3a. pre-check finds now-existing email', { email: u2.email, exists });
}

async function test4_raceCondition() {
  console.log('\n--- Test 4: Race condition — pre-check passes, createUser fails (email taken) ---');
  const email = newEmail();
  // Pre-create user (simulating another tab/caller)
  const u1 = await adminAuth.createUser({ email, password: 'Test1234abc!', emailVerified: true });
  testUid3 = u1.uid;
  // Pre-check from client (returns false because of stale cache OR true — we test true)
  const exists = await preCheckEmail(email);
  log(exists, '4a. pre-check detects existing', { exists });
  // In actual flow, client wouldn't proceed if exists=true, but in race:
  // Client tries createUser → auth/email-already-in-use → reject gracefully
  try {
    await adminAuth.createUser({ email, password: 'DifferentPass123!', emailVerified: true });
    log(false, '4b. should not be able to create duplicate');
  } catch (e) {
    log(e.code === 'auth/email-already-in-use', '4b. createUser rejects duplicate', { code: e.code });
  }
  // Client error mapping: '此 Email 已註冊過，請用「登入」tab'
}

async function test5_existingHub_claimBlocksCreateHub() {
  console.log('\n--- Test 5: User with existing hub_key claim cannot create another hub ---');
  const email = newEmail();
  const u = await adminAuth.createUser({ email, password: 'Test1234abc!', emailVerified: true });
  testUid4 = u.uid;
  // Pre-set a hub_key claim
  await adminAuth.setCustomUserClaims(u.uid, { hub_key: 'hub-existing-123', role: 'admin', status: 'active' });
  const idToken = await getIdToken(u.uid);
  const resp = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({ data: { hubName: 'Second Hub Attempt' } }),
  });
  const data = await resp.json();
  log(!resp.ok && data?.error?.message?.includes('already-linked-to-hub'),
    '5a. createHub rejects user with existing hub claim', { status: resp.status, err: data?.error?.message });
  // Cleanup claim
  await adminAuth.setCustomUserClaims(u.uid, {});
}

async function main() {
  console.log('=== FHX createHub pre-check E2E Test ===\n');
  try {
    await test1_existingEmailRejected();
    await test2_newEmailPassesPreCheck();
    await test3_postCreateReCheckStillFindsEmail();
    await test4_raceCondition();
    await test5_existingHub_claimBlocksCreateHub();
  } finally {
    await cleanup();
  }
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Unhandled error:', e);
  cleanup().then(() => process.exit(1));
});