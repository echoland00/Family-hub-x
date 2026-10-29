// Use the same Firebase config to test from Node
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc, connectFirestoreEmulator } from 'firebase/firestore';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';

const app = initializeApp({
  apiKey: "AIzaSyC0717TOX3YK_Zck6UNIoXFOGMNlhH_FsM",
  authDomain: "family-hub-v2-72195.firebaseapp.com",
  projectId: "family-hub-v2-72195",
  storageBucket: "family-hub-v2-72195.firebasestorage.app",
  messagingSenderId: "178135700731",
  appId: "1:178135700731:web:668ffed07c9e670d564c5e"
});

const auth = getAuth(app);
const db = getFirestore(app);

try {
  const cred = await signInAnonymously(auth);
  console.log('anon uid:', cred.user.uid);
  // List hubs
  const hubsSnap = await getDocs(collection(db, 'artifacts', '1:178135700731:web:668ffed07c9e670d564c5e', 'public', 'data', 'hubs'));
  console.log('hubs count:', hubsSnap.size);
  for (const h of hubsSnap.docs) {
    console.log('  hubKey:', h.id, 'name:', h.data()?.profile?.name);
  }
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.code, e.message);
  process.exit(1);
}
