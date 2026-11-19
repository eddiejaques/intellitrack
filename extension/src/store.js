const db = new Promise((resolve, reject) => {
  const request = indexedDB.open('intellitrack', 1);
  request.onupgradeneeded = () => {
    const events = request.result.createObjectStore('events', {keyPath:['sessionId','id']});
    events.createIndex('session', 'sessionId');
    events.createIndex('request', 'raw_ref');
    request.result.createObjectStore('sessions', {keyPath:'id'});
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function transaction(names, mode, run) {
  const tx = (await db).transaction(names,mode);
  return new Promise((resolve,reject) => {
    const result = run(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error);
  });
}
export const putSession = session => transaction('sessions','readwrite',tx => tx.objectStore('sessions').put(session));
export const getSession = id => transaction('sessions','readonly',tx => tx.objectStore('sessions').get(id));
export const listEvents = id => transaction('events','readonly',tx => tx.objectStore('events').index('session').getAll(id));
export const addEvents = events => transaction('events','readwrite',tx => {
  for (const event of events) tx.objectStore('events').put(event);
});
export const updateTransport = (sessionId,id,transport) => transaction('events','readwrite',tx => {
  const cursor = tx.objectStore('events').index('request').openCursor(id);
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (!row) return;
    if (row.value.sessionId === sessionId) {
      row.update({...row.value,transport:{...row.value.transport,...transport}});
    }
    row.continue();
  };
});
export const purge = before => transaction(['sessions','events'],'readwrite',tx => {
  const sessions = tx.objectStore('sessions').openCursor();
  sessions.onsuccess = () => {
    const row = sessions.result;
    if (!row) return;
    if (row.value.startedAt < before) {
      const events = tx.objectStore('events').index('session').openCursor(row.key);
      events.onsuccess = () => {
        if (!events.result) return;
        events.result.delete();
        events.result.continue();
      };
      row.delete();
    }
    row.continue();
  };
});
