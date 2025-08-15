// If frontend and backend are same origin (Render Node Web Service), keep io().
// If you host frontend elsewhere (e.g., GitHub Pages), set SIGNALING_URL to your Render URL.
// const socket = io("https://YOUR-APP.onrender.com");
const socket = io();

let myKey = null;
let remoteKey = null;

let pc = null;
let dc = null; // data channel

const STUN = { urls: "stun:stun.l.google.com:19302" };
const CHUNK_SIZE = 16 * 1024; // 16KB

const els = {
  myKey: document.getElementById("myKey"),
  regen: document.getElementById("regen"),
  linkKeyInput: document.getElementById("linkKeyInput"),
  linkBtn: document.getElementById("linkBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  status: document.getElementById("status"),
  fileInput: document.getElementById("fileInput"),
  fileBox: document.getElementById("fileBox"),
  fileList: document.getElementById("fileList"),
};

// ---------- Utilities
function makeKey() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function setStatus(t) { els.status.textContent = t; }
function uiKey(k) { els.myKey.textContent = k; }
function ensureOpen() { return dc && dc.readyState === "open"; }
function log(...a){ console.log("[FilePort]", ...a); }

// ---------- Socket lifecycle
socket.on("connect", () => {
  myKey = makeKey();
  uiKey(myKey);
  socket.emit("register-key", myKey);
  setStatus("Share your key with the other device, then link.");
});

socket.on("registered", ({ key }) => log("registered:", key));

els.regen.onclick = () => {
  if (pc) return alert("Disconnect first to regenerate key.");
  myKey = makeKey();
  uiKey(myKey);
  socket.emit("register-key", myKey);
  setStatus("Key regenerated.");
};

// ---------- Linking
els.linkBtn.onclick = () => {
  const targetKey = (els.linkKeyInput.value || "").trim().toUpperCase();
  if (!targetKey || targetKey === myKey) return alert("Enter a valid target key.");
  socket.emit("link-request", { targetKey, fromKey: myKey });
  setStatus("Link request sent to " + targetKey + " …");
};

socket.on("incoming-link-request", ({ fromKey }) => {
  const accept = confirm(`Device ${fromKey} wants to link. Accept?`);
  socket.emit("link-response", { targetKey: fromKey, accepted: !!accept });
  if (accept) startAsReceiver(fromKey);
});

socket.on("link-response", ({ accepted, fromKey }) => {
  if (!accepted) return setStatus(`Link rejected by ${fromKey}.`);
  setStatus(`Linked with ${fromKey}. Establishing connection…`);
  startAsSender(fromKey);
});

socket.on("link-error", ({ message }) => setStatus("Error: " + message));

// ---------- WebRTC signaling
socket.on("webrtc-offer", async ({ sdp, fromKey }) => {
  if (!pc) createPeer(false, fromKey);
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc-answer", { targetKey: fromKey, sdp: pc.localDescription });
});

socket.on("webrtc-answer", async ({ sdp }) => {
  if (!pc) return;
  await pc.setRemoteDescription(sdp);
});

socket.on("ice-candidate", async ({ candidate }) => {
  try { if (candidate && pc) await pc.addIceCandidate(candidate); }
  catch (e) { console.warn("ICE err", e); }
});

// ---------- Peer setup
function createPeer(isInitiator, partnerKey) {
  remoteKey = partnerKey;
  pc = new RTCPeerConnection({ iceServers: [STUN] });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) socket.emit("ice-candidate", { targetKey: remoteKey, candidate: ev.candidate });
  };
  pc.onconnectionstatechange = () => {
    log("pc state:", pc.connectionState);
    if (pc.connectionState === "connected") {
      setStatus("Connected. You can send files.");
      els.disconnectBtn.disabled = false;
    }
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) cleanup();
  };
  pc.ondatachannel = (ev) => setupDC(ev.channel);

  if (isInitiator) {
    setupDC(pc.createDataChannel("fileport"));
  }
}

function setupDC(channel) {
  dc = channel;
  dc.binaryType = "arraybuffer";
  dc.onopen = () => setStatus("Channel open. Ready.");
  dc.onclose = () => setStatus("Channel closed.");
  dc.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "meta") beginReceive(msg);
      if (msg.type === "complete") finishReceive(msg.fileId);
    } else {
      handleChunk(ev.data);
    }
  };
}

async function startAsSender(partnerKey) {
  createPeer(true, partnerKey);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { targetKey: partnerKey, sdp: pc.localDescription });
}

function startAsReceiver(partnerKey) {
  createPeer(false, partnerKey);
}

// ---------- File sending
els.fileInput.onchange = (e) => {
  const files = Array.from(e.target.files || []);
  if (!ensureOpen()) return alert("Link first. Channel not open.");
  files.forEach(sendFile);
};

// drag & drop
els.fileBox.addEventListener("dragover", (e) => { e.preventDefault(); });
els.fileBox.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  if (!ensureOpen()) return alert("Link first. Channel not open.");
  files.forEach(sendFile);
});

function sendFile(file) {
  const fileId = Math.random().toString(36).slice(2, 10);
  addFileEntrySend(fileId, file.name, file.size);

  // metadata first
  dc.send(JSON.stringify({ type: "meta", fileId, name: file.name, mime: file.type, size: file.size }));

  // stream chunks
  const reader = file.stream ? file.stream().getReader() : null;
  if (reader) {
    (async () => {
      let read;
      while (!(read = await reader.read()).done) {
        const chunk = read.value;
        const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        dc.send(ab);
        incProgress(fileId, chunk.byteLength, file.size);
        // prevent huge buffer buildup on slow links
        while (dc.bufferedAmount > 1_000_000) await new Promise(r => setTimeout(r, 10));
      }
      dc.send(JSON.stringify({ type: "complete", fileId }));
      markSendComplete(fileId);
    })();
  } else {
    // fallback slicing
    let offset = 0;
    const next = async () => {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const blob = file.slice(offset, end);
      const ab = await blob.arrayBuffer();
      dc.send(ab);
      offset = end;
      incProgress(fileId, ab.byteLength, file.size);
      if (offset < file.size) {
        while (dc.bufferedAmount > 1_000_000) await new Promise(r => setTimeout(r, 10));
        next();
      } else {
        dc.send(JSON.stringify({ type: "complete", fileId }));
        markSendComplete(fileId);
      }
    };
    next();
  }
}

// ---------- Receiving
const pending = {}; // fileId -> { name, size, got, chunks[] }

function beginReceive(meta) {
  pending[meta.fileId] = { name: meta.name, mime: meta.mime, size: meta.size, got: 0, chunks: [] };
  addFileEntryReceive(meta.fileId, meta.name, meta.size);
}

function handleChunk(buf) {
  // assign to first incomplete file
  const key = Object.keys(pending).find(k => pending[k].got < pending[k].size);
  if (!key) return;
  const o = pending[key];
  o.chunks.push(buf);
  o.got += buf.byteLength;
  setProgress(key, o.got, o.size);
}

function finishReceive(fileId) {
  const o = pending[fileId];
  if (!o) return;
  const blob = new Blob(o.chunks, { type: o.mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = o.name; a.textContent = `Download ${o.name}`;
  const row = document.getElementById("fe-" + fileId);
  row.querySelector(".actions").innerHTML = "";
  row.querySelector(".actions").appendChild(a);
  delete pending[fileId];
}

// ---------- UI helpers
function addFileEntrySend(id, name, size) {
  const div = document.createElement("div");
  div.className = "file-entry";
  div.id = "fe-" + id;
  div.innerHTML = `<div>Sending: ${name} (${Math.round(size/1024)} KB)</div>
                   <div class="actions"><div class="progress"><i></i></div></div>`;
  els.fileList.appendChild(div);
}
function addFileEntryReceive(id, name, size) {
  const div = document.createElement("div");
  div.className = "file-entry";
  div.id = "fe-" + id;
  div.innerHTML = `<div>Receiving: ${name} (${Math.round(size/1024)} KB)</div>
                   <div class="actions"><div class="progress"><i></i></div></div>`;
  els.fileList.appendChild(div);
}
function setProgress(id, got, size) {
  const row = document.getElementById("fe-" + id);
  if (!row) return;
  const bar = row.querySelector(".progress > i");
  const pct = Math.min(100, Math.round((got / size) * 100));
  bar.style.width = pct + "%";
}
function incProgress(id, inc, size) {
  const row = document.getElementById("fe-" + id);
  if (!row) return;
  const bar = row.querySelector(".progress > i");
  const cur = parseInt(bar.style.width || "0", 10);
  const target = Math.min(100, cur + Math.round((inc / size) * 100));
  bar.style.width = target + "%";
}
function cleanup() {
  try { if (dc) dc.close(); } catch(e){}
  try { if (pc) pc.close(); } catch(e){}
  dc = null; pc = null; remoteKey = null;
  els.disconnectBtn.disabled = true;
  setStatus("Disconnected.");
}
els.disconnectBtn.onclick = cleanup;
