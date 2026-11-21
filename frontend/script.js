/**
 * ShopSmart AI Customer Support - Frontend Voice Controller
 * Connects to LiveKit Room via WebRTC with audio streaming, live visualizer & transcripts.
 */

// State variables
let currentRoom = null;
let isConnected = false;
let isMuted = false;
let callDurationTimer = null;
let callSeconds = 0;
let audioContext = null;
let analyser = null;
let animationFrameId = null;
let speechRecognizer = null;

// DOM Elements
const callBtn = document.getElementById("call-btn");
const callBtnText = document.getElementById("call-btn-text");
const muteBtn = document.getElementById("mute-btn");
const micIcon = document.getElementById("mic-icon");
const connectionStatusBadge = document.getElementById("connection-status-badge");
const voiceOrb = document.getElementById("voice-orb");
const callTimerEl = document.getElementById("call-timer");
const agentActiveBadge = document.getElementById("agent-active-badge");
const transcriptFeed = document.getElementById("transcript-feed");
const transcriptionStatus = document.getElementById("transcription-status");
const serviceStatusEl = document.getElementById("service-status");
const serviceStatusText = document.getElementById("service-status-text");
const canvas = document.getElementById("visualizer-canvas");
const canvasCtx = canvas.getContext("2d");

// Initialize on page load
document.addEventListener("DOMContentLoaded", () => {
  checkBackendHealth();
  setupCanvas();
  setupTabs();
  initSpeechRecognition();
  loadDatabaseData();
});

// 1. Health check to backend
async function checkBackendHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error("Health check failed");
    const data = await res.json();
    if (data.status === "healthy") {
      serviceStatusEl.className = "status-indicator ready";
      serviceStatusText.textContent = "AI Services Ready";
    } else {
      serviceStatusEl.className = "status-indicator error";
      if (data.warning) {
        serviceStatusText.textContent = "Invalid Secret Key";
        addTranscriptMessage("system", "⚠️ " + data.warning);
      } else {
        serviceStatusText.textContent = "API Keys Missing";
      }
    }
  } catch (err) {
    serviceStatusEl.className = "status-indicator error";
    serviceStatusText.textContent = "Backend Offline";
  }
}

// 2. Start / End Call Toggle
callBtn.addEventListener("click", async () => {
  if (isConnected) {
    await endCall();
  } else {
    await startCall();
  }
});

// Mute button handler
muteBtn.addEventListener("click", async () => {
  if (!currentRoom) return;
  isMuted = !isMuted;
  await currentRoom.localParticipant.setMicrophoneEnabled(!isMuted);

  if (isMuted) {
    muteBtn.style.background = "rgba(239, 68, 68, 0.2)";
    muteBtn.style.borderColor = "rgba(239, 68, 68, 0.4)";
    connectionStatusBadge.textContent = "Microphone Muted";
    micIcon.innerHTML = `
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
      <line x1="12" x2="12" y1="19" y2="22"/>
    `;
  } else {
    muteBtn.style.background = "";
    muteBtn.style.borderColor = "";
    connectionStatusBadge.textContent = "Listening to you...";
    micIcon.innerHTML = `
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" x2="12" y1="19" y2="22"/>
    `;
  }
});

// 3. Start LiveKit Voice Call
async function startCall() {
  try {
    setOrbState("connecting", "Connecting to Sam...");
    callBtn.disabled = true;
    callBtnText.textContent = "Connecting...";

    // Step A: Fetch LiveKit JWT Token from FastAPI backend
    const tokenRes = await fetch("/api/token?room=shopsmart-support&name=Customer");
    if (!tokenRes.ok) {
      throw new Error(`Failed to generate room token: ${tokenRes.statusText}`);
    }
    const { token, url: livekitUrl } = await tokenRes.json();

    // Step B: Initialize LiveKit Room
    const Room = window.LivekitClient.Room;
    const RoomEvent = window.LivekitClient.RoomEvent;
    const Track = window.LivekitClient.Track;

    currentRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    // Handle remote audio from agent (Sam)
    currentRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const audioElement = track.attach();
        audioElement.volume = 1.0;
        audioElement.muted = false;
        audioElement.autoplay = true;
        document.body.appendChild(audioElement);
        audioElement.play().catch((e) => console.log("Audio autoplay prevented:", e));
        addTranscriptMessage("system", "Sam has connected to the call.");
        agentActiveBadge.classList.remove("hidden");
      }
    });

    // Listen for room transcription events from LiveKit
    if (RoomEvent.TranscriptionReceived) {
      currentRoom.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
        for (const seg of segments) {
          if (seg.final && seg.text) {
            const isAgent = participant ? !participant.isLocal : true;
            addTranscriptMessage(isAgent ? "agent" : "user", seg.text);
          }
        }
      });
    }

    // Handle active speaking events
    currentRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!speakers || speakers.length === 0) {
        setOrbState("listening", "Listening to you...");
        return;
      }

      const hasAgentSpeaking = speakers.some((s) => !s.isLocal);
      const hasUserSpeaking = speakers.some((s) => s.isLocal);

      if (hasAgentSpeaking) {
        setOrbState("speaking", "Sam is speaking...");
      } else if (hasUserSpeaking) {
        setOrbState("listening", "Listening to you...");
      }
    });

    // Handle participant disconnected
    currentRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      addTranscriptMessage("system", `${participant.identity} disconnected.`);
    });

    // Handle room disconnected
    currentRoom.on(RoomEvent.Disconnected, () => {
      cleanupCallUI();
    });

    // Step C: Connect to LiveKit WebRTC server
    await currentRoom.connect(livekitUrl, token);

    // Check if Sam is in the room within 5 seconds
    setTimeout(() => {
      if (isConnected && (!currentRoom.remoteParticipants || currentRoom.remoteParticipants.size === 0)) {
        addTranscriptMessage(
          "system",
          "⚠️ Sam is not connected to the room yet! Please make sure you are running 'python backend\\agent.py dev' in your second terminal window."
        );
      }
    }, 5000);

    // Step D: Enable local microphone
    await currentRoom.localParticipant.setMicrophoneEnabled(true);
    setupMicrophoneVisualizer();

    // Update UI state
    isConnected = true;
    isMuted = false;
    callBtn.disabled = false;
    callBtn.className = "btn btn-danger btn-call";
    callBtnText.textContent = "End Call";
    muteBtn.disabled = false;
    agentActiveBadge.classList.remove("hidden");
    startCallTimer();
    setOrbState("listening", "Connected! Sam is listening...");

    // Start local speech recognition for live transcripts
    startSpeechRecognition();

    addTranscriptMessage("system", "Connected to ShopSmart Support Room. Speak into your mic.");

  } catch (err) {
    console.error("Error starting voice call:", err);
    alert(`Could not start call: ${err.message}\nMake sure microphone permission is granted.`);
    cleanupCallUI();
  }
}

// 4. End Call
async function endCall() {
  if (currentRoom) {
    try {
      await currentRoom.disconnect();
    } catch (e) {
      console.warn("Disconnect error:", e);
    }
  }
  cleanupCallUI();
}

function cleanupCallUI() {
  isConnected = false;
  isMuted = false;
  currentRoom = null;

  callBtn.disabled = false;
  callBtn.className = "btn btn-primary btn-call";
  callBtnText.textContent = "Start Voice Call";
  muteBtn.disabled = true;
  agentActiveBadge.classList.add("hidden");
  stopCallTimer();
  stopSpeechRecognition();
  setOrbState("idle", "Ready to Connect");
  stopVisualizer();

  // Remove any dynamically created audio elements
  document.querySelectorAll("audio").forEach((el) => el.remove());
}

// 5. Visualizer Canvas
function setupCanvas() {
  const resize = () => {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
  };
  resize();
  window.addEventListener("resize", resize);
}

async function setupMicrophoneVisualizer() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;

    // Reuse the LiveKit local participant microphone track if available
    const pub = currentRoom?.localParticipant?.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
    if (pub && pub.track && pub.track.mediaStreamTrack) {
      const mediaStream = new MediaStream([pub.track.mediaStreamTrack]);
      const source = audioContext.createMediaStreamSource(mediaStream);
      source.connect(analyser);
      renderVisualizer();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    renderVisualizer();
  } catch (e) {
    console.warn("Audio visualizer unavailable:", e);
  }
}

function renderVisualizer() {
  if (!analyser) return;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    animationFrameId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height * 0.75;
      const gradient = canvasCtx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
      gradient.addColorStop(0, "rgba(79, 70, 229, 0.1)");
      gradient.addColorStop(1, "rgba(16, 185, 129, 0.6)");

      canvasCtx.fillStyle = gradient;
      canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
      x += barWidth;
    }
  };
  draw();
}

function stopVisualizer() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (canvasCtx && canvas) {
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// 6. Voice Orb States
function setOrbState(state, label) {
  voiceOrb.className = `voice-orb ${state}`;
  connectionStatusBadge.textContent = label;
}

// 7. Call Timer
function startCallTimer() {
  callSeconds = 0;
  callTimerEl.classList.remove("hidden");
  callTimerEl.textContent = "00:00";
  callDurationTimer = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, "0");
    const secs = String(callSeconds % 60).padStart(2, "0");
    callTimerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  if (callDurationTimer) {
    clearInterval(callDurationTimer);
    callDurationTimer = null;
  }
  callTimerEl.classList.add("hidden");
}

// 8. Live Speech Recognition (for browser transcript preview)
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = true;
    speechRecognizer.interimResults = false;
    speechRecognizer.lang = "en-US";

    speechRecognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (text) {
            addTranscriptMessage("user", text);
          }
        }
      }
    };

    speechRecognizer.onerror = (e) => {
      console.warn("Speech recognition warning:", e.error);
    };
  }
}

function startSpeechRecognition() {
  if (speechRecognizer) {
    try {
      speechRecognizer.start();
      transcriptionStatus.textContent = "Transcribing Live";
      transcriptionStatus.style.color = "#10b981";
    } catch (e) {}
  }
}

function stopSpeechRecognition() {
  if (speechRecognizer) {
    try {
      speechRecognizer.stop();
      transcriptionStatus.textContent = "Idle";
      transcriptionStatus.style.color = "";
    } catch (e) {}
  }
}

// 9. Transcript Message Feed
function addTranscriptMessage(type, text) {
  const msgEl = document.createElement("div");
  msgEl.className = `message ${type}-msg`;

  let speakerName = "";
  if (type === "user") speakerName = "You (Customer)";
  else if (type === "agent") speakerName = "Sam (ShopSmart AI)";

  if (speakerName) {
    const speakerEl = document.createElement("div");
    speakerEl.className = "msg-speaker";
    speakerEl.textContent = speakerName;
    msgEl.appendChild(speakerEl);
  }

  const textEl = document.createElement("div");
  textEl.textContent = text;
  msgEl.appendChild(textEl);

  transcriptFeed.appendChild(msgEl);
  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
}

// 10. Copy Prompt Helper
window.copyPrompt = (promptText) => {
  navigator.clipboard.writeText(promptText).catch(() => {});
  addTranscriptMessage("system", `💡 Prompt hint: "${promptText}" - Say this into your mic!`);
};

// 11. Tabs Controller
function setupTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

      btn.classList.add("active");
      const tabId = `tab-${btn.dataset.tab}`;
      const target = document.getElementById(tabId);
      if (target) target.classList.add("active");

      if (btn.dataset.tab === "database-view") {
        loadDatabaseData();
      }
    });
  });
}

// 12. Database Data Loader
window.loadDatabaseData = async () => {
  const ordersListEl = document.getElementById("db-orders-list");
  const productsListEl = document.getElementById("db-products-list");
  const ticketsListEl = document.getElementById("db-tickets-list");

  try {
    const [ordersRes, productsRes, ticketsRes] = await Promise.all([
      fetch("/api/orders"),
      fetch("/api/products"),
      fetch("/api/tickets"),
    ]);

    const orders = await ordersRes.json();
    const products = await productsRes.json();
    const tickets = await ticketsRes.json();

    // Render Orders
    if (orders.length === 0) {
      ordersListEl.innerHTML = '<div class="card-hint">No orders found.</div>';
    } else {
      ordersListEl.innerHTML = orders.map((o) => `
        <div class="db-item">
          <div class="db-item-header">
            <span>${o.order_id} - ${o.customer_name}</span>
            <span class="chip-tag ${o.status === 'Delivered' ? 'success' : o.status === 'In Transit' ? '' : 'alert'}">${o.status}</span>
          </div>
          <div class="db-item-details">
            Carrier: ${o.carrier || 'N/A'} (${o.tracking_number || 'Pending'}) | Delivery: ${o.estimated_delivery}
          </div>
        </div>
      `).join("");
    }

    // Render Products
    if (products.length === 0) {
      productsListEl.innerHTML = '<div class="card-hint">No products found.</div>';
    } else {
      productsListEl.innerHTML = products.map((p) => `
        <div class="db-item">
          <div class="db-item-header">
            <span>${p.name} (${p.product_id})</span>
            <span>$${p.price.toFixed(2)}</span>
          </div>
          <div class="db-item-details">
            Category: ${p.category} | Stock: <strong style="color: ${p.stock > 0 ? '#10b981' : '#ef4444'}">${p.stock} units</strong>
          </div>
        </div>
      `).join("");
    }

    // Render Tickets
    if (tickets.length === 0) {
      ticketsListEl.innerHTML = '<div class="card-hint">No tickets currently escalated. Ask Sam to escalate to create one!</div>';
    } else {
      ticketsListEl.innerHTML = tickets.map((t) => `
        <div class="db-item">
          <div class="db-item-header">
            <span>${t.ticket_id} (${t.priority.toUpperCase()})</span>
            <span class="chip-tag">${t.status}</span>
          </div>
          <div class="db-item-details">
            Customer: ${t.customer_name} (${t.contact_info}) - Issue: ${t.issue}
          </div>
        </div>
      `).join("");
    }
  } catch (err) {
    console.error("Failed to load database:", err);
  }
};
