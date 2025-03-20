// SignalWire WebRTC Client Implementation

// DOM elements
const callStatus = document.querySelector('.call-status');
const callInfo = document.getElementById('call-info');
const callerId = document.getElementById('caller-id');
const calledNumber = document.getElementById('called-number');
const answerBtn = document.getElementById('answer-btn');
const hangupBtn = document.getElementById('hangup-btn');
const volumeControl = document.getElementById('volume');
const testAudioBtn = document.getElementById('test-audio');

// Connect to the Socket.IO server
const socket = io();

// Current call state
let currentCall = null;
let localStream = null;

// Global remote audio element for call audio
let remoteAudio = null;

// Request microphone permissions only when needed
async function setupMicrophonePermissions() {
  try {
    // If we already have a stream, stop all tracks to release the mic
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
    
    // Request microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }, 
      video: false 
    });
    
    console.log('Microphone permissions granted');
    localStream = stream;
    return true;
  } catch (error) {
    console.error('Error accessing microphone:', error);
    callStatus.textContent = 'Status: Microphone access denied. Please allow microphone use.';
    return false;
  }
}

// Release microphone when call ends
function releaseMicrophone() {
  if (localStream) {
    console.log('Releasing microphone');
    localStream.getTracks().forEach(track => {
      track.stop();
    });
    localStream = null;
  }
}

// Socket.IO event listeners
socket.on('connect', () => {
  console.log('Connected to server');
  callStatus.textContent = 'Status: Connected to server';
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  callStatus.textContent = 'Status: Disconnected from server';
  // Hide buttons and call info on disconnect
  if (answerBtn) answerBtn.classList.add('hidden');
  if (hangupBtn) hangupBtn.classList.add('hidden');
  callInfo.style.display = 'none';
  resetCallUI();
  releaseMicrophone();
});

socket.on('callError', (data) => {
  console.error('Call error:', data);
  callStatus.textContent = `Status: Error - ${data.error}`;
  callStatus.style.color = 'red';
  
  // Try to recover UI
  if (hangupBtn) hangupBtn.classList.add('hidden');
  if (answerBtn) answerBtn.classList.remove('hidden');
  
  // Display error notification
  alert(`Call error: ${data.error}. Please try again.`);
});

socket.on('incomingCall', (data) => {
  console.log('Incoming call:', data);
  
  currentCall = {
    callId: data.callId,
    from: data.from,
    to: data.to
  };
  
  // Reset any previous error styling
  callStatus.style.color = '';
  
  // Update UI
  callStatus.textContent = 'Status: Incoming Call';
  callInfo.style.display = 'block';
  callerId.textContent = data.from;
  calledNumber.textContent = data.to;
  
  // Show answer button
  answerBtn.classList.remove('hidden');
  hangupBtn.classList.remove('hidden');
  
  // Play ringtone
  playRingtone();
});

socket.on('callAnswered', (data) => {
  if (currentCall && currentCall.callId === data.callId) {
    callStatus.textContent = `Status: ${data.status || 'Call in Progress'}`;
    stopRingtone();
    
    // Ensure audio output is enabled for speakers
    enableAudioOutput();
    
    // If we received a remote stream with the answer response, handle it
    if (data.remoteStream) {
      console.log('Received remote stream with answer response');
      handleRemoteStream(data.remoteStream);
    }
  }
});

socket.on('callEnded', (data) => {
  console.log('Call ended event received:', data);
  
  // Only process if this is our current call
  if (currentCall && data.callId === currentCall.callId) {
    console.log('Our current call has ended');
    
    // Stop any audio playback
    if (remoteAudio) {
      remoteAudio.pause();
      if (remoteAudio.src) {
        remoteAudio.src = '';
      }
      if (remoteAudio.srcObject) {
        remoteAudio.srcObject = null;
      }
    }
    
    // Update UI with a distinctive "call ended" message
    callStatus.textContent = 'Status: Call Ended';
    callStatus.style.backgroundColor = '#ffcccc';
    callStatus.style.padding = '10px';
    callStatus.style.borderRadius = '4px';
    callStatus.style.fontWeight = 'bold';
    
    // Add a visible notification
    const notification = document.createElement('div');
    notification.textContent = 'The call has ended';
    notification.style.color = '#cc0000';
    notification.style.fontWeight = 'bold';
    notification.style.padding = '10px';
    notification.style.marginTop = '10px';
    notification.style.backgroundColor = '#ffeeee';
    notification.style.borderRadius = '4px';
    notification.style.textAlign = 'center';
    
    // Find a good place to add the notification
    const container = document.querySelector('.call-container');
    if (container) {
      container.appendChild(notification);
      
      // Auto-remove notification after 5 seconds
      setTimeout(() => {
        container.removeChild(notification);
      }, 5000);
    }
    
    // Hide call controls
    answerBtn.classList.add('hidden');
    hangupBtn.classList.add('hidden');
    
    // Reset call data
    currentCall = null;
    
    // Release microphone
    releaseMicrophone();
    
    // Show call ended message and reset UI after delay
    setTimeout(() => {
      // Fade out the call info panel
      if (callInfo) {
        callInfo.style.transition = 'opacity 1s';
        callInfo.style.opacity = '0.5';
      }
      
      // After 3 seconds reset to ready state
      setTimeout(() => {
        resetCallUI();
        callStatus.textContent = 'Status: Connected to server';
        callStatus.style.backgroundColor = '';
        callStatus.style.padding = '';
      }, 3000);
    }, 2000);
  }
});

// Add a new listener for active calls
socket.on('callActive', (data) => {
  console.log('Call is now active:', data);
  if (currentCall && currentCall.callId === data.callId) {
    callStatus.textContent = 'Status: Call Active - ' + data.state;
    
    // Force audio to be enabled
    forceAudioOutput();
  }
});

// Replace enableAudioOutput with this more aggressive approach
socket.on('enableAudioOutput', (data) => {
  if (currentCall && currentCall.callId === data.callId) {
    console.log('Explicitly enabling audio output for call:', data.callId);
    forceAudioOutput();
  }
});

// Function to show debug info in the UI
function showDebugInfo(info) {
  // Create or update debug container
  let debugContainer = document.getElementById('debug-container');
  if (!debugContainer) {
    debugContainer = document.createElement('div');
    debugContainer.id = 'debug-container';
    debugContainer.style.marginTop = '15px';
    debugContainer.style.padding = '10px';
    debugContainer.style.backgroundColor = '#f0f0f0';
    debugContainer.style.border = '1px solid #ccc';
    debugContainer.style.borderRadius = '4px';
    debugContainer.style.fontSize = '12px';
    debugContainer.style.fontFamily = 'monospace';
    
    // Add a title
    const title = document.createElement('div');
    title.textContent = 'Audio Debug Info';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '5px';
    debugContainer.appendChild(title);
    
    // Add to page
    const container = document.getElementById('video-container');
    if (container) {
      container.appendChild(debugContainer);
    }
  }
  
  // Update content
  const content = document.createElement('div');
  if (typeof info === 'object') {
    content.textContent = JSON.stringify(info, null, 2);
  } else {
    content.textContent = info;
  }
  
  // Clear previous content and add new
  while (debugContainer.childNodes.length > 1) {
    debugContainer.removeChild(debugContainer.lastChild);
  }
  debugContainer.appendChild(content);
}

// Add debug info to handle remote stream - call at end of handleRemoteStream
function logAudioStreamStatus() {
  console.log("Running audio stream status check");
  
  // Check audio elements
  const audioElements = document.querySelectorAll('audio');
  const audioStatus = Array.from(audioElements).map(audio => ({
    id: audio.id,
    paused: audio.paused,
    muted: audio.muted,
    volume: audio.volume,
    hasSource: !!audio.src,
    hasSourceObject: !!audio.srcObject,
    networkState: audio.networkState,
    readyState: audio.readyState
  }));
  
  // Check AudioContext
  let audioContextStatus = 'Not initialized';
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const tempContext = new AudioContext();
    audioContextStatus = tempContext.state;
    tempContext.close();
  } catch (e) {
    audioContextStatus = `Error: ${e.message}`;
  }
  
  // Display debug info
  showDebugInfo({
    timestamp: new Date().toISOString(),
    callActive: !!currentCall,
    audioElements: audioStatus,
    audioContextStatus,
    remoteAudioExists: !!remoteAudio,
    currentCall: currentCall ? {
      callId: currentCall.callId,
      from: currentCall.from,
      to: currentCall.to
    } : null
  });
  
  // Schedule next update if we have an active call
  if (currentCall) {
    setTimeout(logAudioStreamStatus, 2000);
  }
}

// Function to handle the remote stream - simplified and improved
function handleRemoteStream(streamInfo) {
  console.log('Processing remote stream:', JSON.stringify(streamInfo));
  
  try {
    // Ensure we have an audio container
    const container = document.getElementById('video-container');
    if (!container) {
      console.error('Could not find audio container element');
      return;
    }
    
    // Remove any existing audio elements to prevent conflicts
    const existingAudio = document.getElementById('remote-audio');
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.srcObject = null;
      existingAudio.src = '';
      if (existingAudio.parentNode) {
        existingAudio.parentNode.removeChild(existingAudio);
      }
    }
    
    // Create fresh audio element
    const audioEl = document.createElement('audio');
    audioEl.id = 'remote-audio';
    audioEl.autoplay = true;
    audioEl.playsInline = true; // Important for iOS
    audioEl.muted = false;
    audioEl.controls = true; // Make controls visible for debugging
    audioEl.style.display = 'block';
    audioEl.style.width = '100%';
    audioEl.style.marginTop = '10px';
    audioEl.volume = volumeControl ? volumeControl.value : 1.0;
    
    // Add to page
    container.appendChild(audioEl);
    remoteAudio = audioEl;
    
    console.log('Created fresh audio element for remote stream');

    // Debug log to check what the stream info actually contains
    console.log('Stream info details:', {
      hasStream: !!streamInfo.stream,
      hasId: !!streamInfo.id,
      type: streamInfo.type,
      keys: Object.keys(streamInfo)
    });

    // Much simpler approach to handle audio - try each method in sequence
    if (streamInfo) {
      let audioConnected = false;
      
      // METHOD 1: Try to use direct stream reference
      if (streamInfo.stream && !audioConnected) {
        try {
          console.log('Trying direct stream reference');
          audioEl.srcObject = streamInfo.stream;
          audioConnected = true;
          console.log('Direct stream reference connected');
        } catch (e) {
          console.error('Direct stream reference failed:', e);
        }
      }
      
      // METHOD 2: Try SignalWire's WebRTC API
      if (!audioConnected && window.Relay && streamInfo.id) {
        try {
          console.log('Trying SignalWire Relay API');
          const stream = window.Relay.RemoteStream.get(streamInfo.id);
          if (stream) {
            audioEl.srcObject = stream;
            audioConnected = true;
            console.log('SignalWire Relay API connected');
          }
        } catch (e) {
          console.error('SignalWire Relay API failed:', e);
        }
      }
      
      // METHOD 3: Classic mediastream URL
      if (!audioConnected && streamInfo.id) {
        try {
          console.log('Trying mediastream URL');
          audioEl.src = `mediastream:${streamInfo.id}`;
          audioConnected = true;
          console.log('Mediastream URL connected');
        } catch (e) {
          console.error('Mediastream URL failed:', e);
        }
      }
      
      // METHOD 4: Direct URL
      if (!audioConnected && streamInfo.url) {
        try {
          console.log('Trying direct URL');
          audioEl.src = streamInfo.url;
          audioConnected = true;
          console.log('Direct URL connected');
        } catch (e) {
          console.error('Direct URL failed:', e);
        }
      }
      
      // If we connected with any method, play the audio
      if (audioConnected) {
        console.log('Attempting to play audio with method:', audioConnected);
        audioEl.play()
          .then(() => {
            console.log('Audio playing successfully');
            callStatus.textContent = 'Status: Call Connected - Audio Playing';
          })
          .catch(err => {
            console.error('Error playing audio:', err);
            
            // Add a big play button that users can click
            const playButton = document.createElement('button');
            playButton.textContent = 'Click to Enable Audio';
            playButton.style.display = 'block';
            playButton.style.margin = '10px auto';
            playButton.style.padding = '15px 30px';
            playButton.style.backgroundColor = '#4CAF50';
            playButton.style.color = 'white';
            playButton.style.border = 'none';
            playButton.style.borderRadius = '4px';
            playButton.style.fontSize = '16px';
            playButton.style.fontWeight = 'bold';
            playButton.style.cursor = 'pointer';
            
            playButton.addEventListener('click', () => {
              audioEl.play()
                .then(() => {
                  playButton.textContent = 'Audio Enabled';
                  playButton.disabled = true;
                  playButton.style.backgroundColor = '#888';
                })
                .catch(e => {
                  console.error('Still cannot play audio:', e);
                  playButton.textContent = 'Audio Failed - Try Again';
                });
            });
            
            container.appendChild(playButton);
          });
      } else {
        console.error('All audio connection methods failed');
        callStatus.textContent = 'Status: Audio Connection Failed';
      }
    }
  } catch (e) {
    console.error('Error handling remote stream:', e);
  }
  
  // Add this at the end of the function
  logAudioStreamStatus();
}

// More effective audio forcing function
function forceAudioOutput() {
  console.log('FORCING AUDIO OUTPUT - this should ensure we can hear the caller');
  
  try {
    // Create and resume AudioContext to unlock audio on the page
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContext();
    
    audioCtx.resume().then(() => {
      console.log('Audio context created and running:', audioCtx.state);
    });
    
    // Force resume any audio elements on the page
    document.querySelectorAll('audio').forEach(audio => {
      if (audio.paused) {
        audio.play().catch(e => console.warn('Could not auto-play audio:', e));
      }
    });
    
    // Try to set audio output to default device
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices()
        .then(devices => {
          const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
          console.log('Available audio output devices:', audioOutputs.map(d => d.label));
          
          // Try to apply output device to our audio element
          const audioEl = document.getElementById('remote-audio');
          if (audioEl && audioEl.setSinkId) {
            audioEl.setSinkId('default')
              .then(() => console.log('Set audio output to default device'))
              .catch(e => console.error('Error setting audio output device:', e));
          }
        })
        .catch(e => console.warn('Could not enumerate devices:', e));
    }
  } catch (e) {
    console.error('Error in forceAudioOutput:', e);
  }
}

// Function to ensure audio output is enabled
function enableAudioOutput(force = false) {
  console.log('Enabling audio output, force =', force);
  
  try {
    // Force audio context to resume if it was suspended
    if (typeof AudioContext !== 'undefined') {
      const audioContext = new AudioContext();
      audioContext.resume().then(() => {
        console.log('AudioContext resumed successfully:', audioContext.state);
      });
    }
    
    // If force is true, use the more aggressive approach
    if (force) {
      forceAudioOutput();
    }
  } catch (e) {
    console.error('Error in enableAudioOutput:', e);
  }
}

// Setup audio controls
if (volumeControl) {
  volumeControl.addEventListener('change', function() {
    if (remoteAudio) {
      remoteAudio.volume = this.value;
      console.log('Volume set to:', this.value);
    }
    
    // Also affect ringtone volume if it's playing
    if (ringtone) {
      ringtone.volume = this.value;
    }
  });
}

if (testAudioBtn) {
  testAudioBtn.addEventListener('click', function() {
    // Play a direct audio file to test speakers
    const testAudio = new Audio('cell-phone-ring.mp3');
    testAudio.volume = volumeControl ? volumeControl.value : 0.7;
    
    // Update UI
    this.textContent = 'Playing...';
    this.disabled = true;
    
    // Play the test sound
    testAudio.play()
      .then(() => {
        console.log('Test audio playing successfully');
        callStatus.textContent = 'Status: Audio Test - Playing Sound';
        
        // Reset button after playback ends
        testAudio.onended = () => {
          this.textContent = 'Test Speaker';
          this.disabled = false;
          callStatus.textContent = 'Status: Connected to server';
        };
      })
      .catch(err => {
        console.error('Error playing test audio:', err);
        this.textContent = 'Test Failed';
        setTimeout(() => {
          this.textContent = 'Try Again';
          this.disabled = false;
        }, 2000);
      });
  });
}

// Button event listeners
answerBtn.addEventListener('click', async () => {
  console.log('Answering call:', currentCall);
  
  if (!currentCall) {
    console.error('No current call to answer');
    return;
  }
  
  // Request microphone permissions
  await setupMicrophonePermissions();
  
  // Update UI
  callStatus.textContent = 'Status: Answering Call...';
  
  // Create a test tone to confirm audio works on this device
  createTestTone();
  
  // Send answer request to the server
  socket.emit('answerCall', { callId: currentCall.callId });
});

// Function to create a test tone to verify audio
function createTestTone() {
  try {
    // Create audio context
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Create oscillator
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // 440 Hz - A note
    
    // Create gain node to control volume
    const gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime); // Low volume
    
    // Connect nodes
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Start and stop after 0.5 seconds
    oscillator.start();
    
    setTimeout(() => {
      oscillator.stop();
      oscillator.disconnect();
      gainNode.disconnect();
      console.log('Test tone completed');
    }, 500);
    
    console.log('Playing test tone to verify audio output works');
  } catch (e) {
    console.error('Could not create test tone:', e);
  }
}

hangupBtn.addEventListener('click', () => {
  console.log('Hanging up call:', currentCall);
  
  if (!currentCall) {
    console.error('No current call to hang up');
    return;
  }
  
  // Update UI immediately for responsiveness
  callStatus.textContent = 'Status: Hanging Up...';
  
  // Send hangup request to server
  socket.emit('hangupCall', { callId: currentCall.callId });
  
  // Stop ringtone if it's playing
  stopRingtone();
});

// Helper functions
function resetCallUI() {
  // Hide buttons
  if (answerBtn) answerBtn.classList.add('hidden');
  if (hangupBtn) hangupBtn.classList.add('hidden');
  
  // Hide call info
  if (callInfo) {
    callInfo.style.display = 'none';
    callInfo.style.opacity = '1'; // Reset opacity
  }
  
  // Remove any remote audio elements
  const remoteAudioEl = document.getElementById('remote-audio');
  if (remoteAudioEl) {
    const container = document.getElementById('video-container');
    if (container) {
      // Remove all children of the video container
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      console.log('Removed remote audio and related elements');
    }
  }
  
  // Reset global reference
  remoteAudio = null;
  
  // Stop ringtone if playing
  stopRingtone();
}

// Ringtone functionality
let ringtone = null;

// Play ringtone function
function playRingtone() {
  stopRingtone(); // Stop any existing ringtone
  
  // Add a subtle indicator
  callStatus.textContent = 'Status: Incoming Call';
  callStatus.style.color = '#cc0000';
  callStatus.style.fontWeight = 'bold';
  
  try {
    // Create ringtone audio element
    ringtone = new Audio('cell-phone-ring.mp3');
    ringtone.loop = true;
    ringtone.volume = 0.7;
    
    // Try to play the ringtone
    ringtone.play().catch(e => {
      console.warn('Could not play ringtone:', e);
      callStatus.textContent = 'Status: Incoming Call - Click "Enable Sounds" button';
    });
  } catch (e) {
    console.error('Error playing ringtone:', e);
  }
}

// Stop ringtone function - simplified
function stopRingtone() {
  if (ringtone) {
    // Only handle audio ringtone
    try {
      ringtone.pause();
      ringtone.currentTime = 0;
    } catch (e) {
      console.error('Error stopping ringtone:', e);
    }
    ringtone = null;
  }
  
  // Reset call status style
  callStatus.style.color = '';
  callStatus.style.fontWeight = '';
}

// Check call status periodically in case server missed an update
function startCallStatusChecking() {
  // If there's an active call, check its status every 5 seconds
  setInterval(() => {
    if (currentCall && currentCall.callId) {
      console.log('Checking call status for', currentCall.callId);
      socket.emit('checkCallStatus', { callId: currentCall.callId });
    }
  }, 5000);
}

// Add ping function to detect disconnections
function setupPing() {
  setInterval(() => {
    // Only send ping if we have an active call to avoid unnecessary traffic
    if (currentCall && currentCall.callId) {
      socket.emit('ping', { callId: currentCall.callId, timestamp: Date.now() });
    }
  }, 10000); // Ping every 10 seconds
}

// Add sound pre-approval functionality
function addEnableSoundsButton() {
  const container = document.querySelector('.call-container');
  if (!container) return;
  
  // Check if element already exists
  if (document.getElementById('enable-sounds-container')) return;
  
  // Create container for the checkbox
  const enableSoundsContainer = document.createElement('div');
  enableSoundsContainer.id = 'enable-sounds-container';
  enableSoundsContainer.style.marginBottom = '15px';
  enableSoundsContainer.style.display = 'flex';
  enableSoundsContainer.style.alignItems = 'center';
  
  // Create checkbox
  const enableSoundsCheckbox = document.createElement('input');
  enableSoundsCheckbox.type = 'checkbox';
  enableSoundsCheckbox.id = 'enable-sounds-checkbox';
  enableSoundsCheckbox.style.marginRight = '10px';
  
  // Create label
  const label = document.createElement('label');
  label.htmlFor = 'enable-sounds-checkbox';
  label.textContent = 'Enable sounds';
  
  // Add elements to container
  enableSoundsContainer.appendChild(enableSoundsCheckbox);
  enableSoundsContainer.appendChild(label);
  
  // Add to the page
  container.insertBefore(enableSoundsContainer, container.firstChild);
  
  // Add change handler
  enableSoundsCheckbox.addEventListener('change', function() {
    if (this.checked) {
      // Create and play a silent audio to unlock audio context
      const silentAudio = new Audio('data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTcuODMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV');
      silentAudio.play().then(() => {
        console.log('Audio context unlocked by user interaction');
        label.textContent = 'Sounds enabled ✓';
      }).catch(e => {
        console.error('Failed to unlock audio context:', e);
        label.textContent = 'Enable sounds (failed, try again)';
        this.checked = false;
      });
    } else {
      label.textContent = 'Enable sounds';
    }
  });
}

// Check call status function
function checkCallStatus() {
  if (currentCall && currentCall.callId) {
    console.log('Checking call status for', currentCall.callId);
    socket.emit('checkCallStatus', { callId: currentCall.callId });
  }
}

// Initialize everything when the page loads
window.addEventListener('DOMContentLoaded', () => {
  // Start call status checking
  startCallStatusChecking();
  
  // Setup ping
  setupPing();
  
  // Add the enable sounds checkbox
  addEnableSoundsButton();
  
  // Start audio status logging immediately
  logAudioStreamStatus();
});

// Socket.IO event handling for media stream changes
socket.on('mediaChanges', (mediaData) => {
  console.log('MEDIA CHANGES EVENT:', JSON.stringify(mediaData));
  
  if (currentCall && mediaData.callId === currentCall.callId && mediaData.remoteStream) {
    console.log('Received media change event from server:', mediaData);
    handleRemoteStream(mediaData.remoteStream);
  }
}); 