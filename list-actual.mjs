import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

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

// Sign in as the bypass user
try {
  const cred = await signInWithEmailAndPassword(auth, 'echoopenc@gmail.com', process.env.ECHO_PWD);
  console.log('Signed in:', cred.user.email, 'uid:', cred.user.uid);
  
  // List hubs under the web appId
  const webAppId = '1:178135700731:web:668ffed07c9e670d564c5e';
  const webHubsSnap = await getDocs(collection(db, 'artifacts', webAppId, 'public', 'data', 'hubs'));
  console.log('WEB appId hubs count:', webHubsSnap.size);
  for (const h of webHubsSnap.docs) {
    console.log('  hub:', h.id, 'name:', h.data()?.profile?.name);
    // Check dishes/categories
    const dishesSnap = await getDocs(collection(db, 'artifacts', webAppId, 'public', 'data', 'hubs', h.id, 'dishes'));
    const catsSnap = await getDocs(collection(db, 'artifacts', webAppId, 'public', 'data', 'hubs', h.id, 'categories'));
    console.log('     dishes:', dishesSnap.size, 'cats:', catsSnap.size);
  }
  
  // List hubs under family-hub-v2
  const v2HubsSnap = await getDocs(collection(db, 'artifacts', 'family-hub-v2', 'public', 'data', 'hubs'));
  console.log('V2 appId hubs count:', v2HubsSnap.size);
  for (const h of v2HubsSnap.docs) {
    console.log('  hub:', h.id, 'name:', h.data()?.profile?.name);
    const dishesSnap = await getDocs(collection(db, 'artifacts', 'family-hub-v2', 'public', 'data', 'hubs', h.id, 'dishes'));
    const catsSnap = await getDocs(collection(db, 'artifacts', 'family-hub-v2', 'public', 'data', 'hubs', h.id, 'categories'));
    console.log('     dishes:', dishesSnap.size, 'cats:', catsSnap.size);
  }
  
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.code, e.message);
  process.exit(1);
}
