require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { SignalWire } = require('@signalwire/realtime-api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Initialize SignalWire client
let signalwireClient = null;
let voiceClient = null;

// Configure CORS
app.use(cors());

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Track active calls
const activeCalls = new Map();
const webhookCalls = new Map();

// Helper function to clean up after a call ends
function handleCallEnded(callId) {
  console.log(`Call ${callId} has ended, cleaning up resources`);
  
  // Clean up the call from our collections
  activeCalls.delete(callId);
  webhookCalls.delete(callId);
  
  // Notify all connected clients that the call has ended
  io.emit('callEnded', { callId });
}

// Poll active calls to detect state changes
function startCallStatePolling() {
  const POLL_INTERVAL = 2000; // Check every 2 seconds
  
  setInterval(() => {
    if (activeCalls.size === 0 && webhookCalls.size === 0) {
      return; // No active calls to check
    }
    
    console.log('Polling active calls for state changes...');
    
    // Check active calls from realtime API
    activeCalls.forEach((call, callId) => {
      console.log(`Checking call ${callId}, current state: ${call.state}`);
      
      // If the call has ended but we haven't cleaned up
      if (['ended', 'ending', 'completed', 'busy', 'failed', 'canceled'].includes(call.state)) {
        console.log(`Call ${callId} is in end state (${call.state}) during polling, cleaning up`);
        handleCallEnded(callId);
      }
    });
    
    // Check active calls from webhooks
    webhookCalls.forEach((call, callId) => {
      // For webhook calls, we might not have state directly, but we can check if they're stale
      const now = Date.now();
      const callTime = call.timestamp || now;
      const callAgeMinutes = (now - callTime) / (1000 * 60);
      
      if (callAgeMinutes > 5) { // If call is older than 5 minutes, clean it up
        console.log(`Webhook call ${callId} is stale (${callAgeMinutes.toFixed(1)} minutes old), cleaning up`);
        handleCallEnded(callId);
      }
    });
  }, POLL_INTERVAL);
  
  console.log(`Call state polling started (interval: ${POLL_INTERVAL}ms)`);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('answerCall', async (data) => {
    console.log('Answering call:', data.callId);
    
    // Check if it's a call we know about from the realtime API
    const call = activeCalls.get(data.callId) || webhookCalls.get(data.callId);
    if (!call) {
      console.log('Call not found');
      return;
    }
    
    try {
      // Answer the call with audio enabled in both directions
      console.log('Attempting to answer call with ID:', data.callId);
      
      // Answer with explicit media configuration for two-way audio
      const answerResult = await call.answer({
        media: {
          audio: true,  // Simplified audio config for maximum compatibility
          video: false
        }
      });
      
      console.log('Call answered successfully. Call is now:', call.state);
      
      // Safely extract call properties for logging
      const safeCallInfo = {
        id: call.id,
        state: call.state,
        direction: call.direction,
        type: call.type,
        from: call.from,
        to: call.to,
      };
      
      // Log only safe properties
      console.log('Call info:', JSON.stringify(safeCallInfo, null, 2));
      
      // Check for and extract media-related properties safely
      const safeMediaInfo = {};
      if (call.mediaType) safeMediaInfo.mediaType = call.mediaType;
      if (call.mediaParams) {
        // Create a shallow copy to avoid circular references
        safeMediaInfo.mediaParams = { ...call.mediaParams };
        // Remove any potentially circular references
        delete safeMediaInfo.mediaParams.context;
        delete safeMediaInfo.mediaParams.call;
      }
      if (call.mediaStatus) safeMediaInfo.mediaStatus = call.mediaStatus;
      
      console.log('Media info:', JSON.stringify(safeMediaInfo, null, 2));
      
      // Extract and forward remote stream info safely
      let remoteStreamInfo = null;
      
      // Try different ways to access the remote stream
      if (call.remoteStream) {
        // Include more complete details about the remote stream
        remoteStreamInfo = {
          id: call.remoteStream.id,
          active: call.remoteStream.active,
          type: 'remote',
          tracks: Array.isArray(call.remoteStream.getTracks) ? 
            call.remoteStream.getTracks().map(t => ({
              kind: t.kind,
              id: t.id,
              enabled: t.enabled
            })) : []
        };
        
        // Add a direct reference to the stream object if possible (will be auto-serialized)
        try {
          remoteStreamInfo.stream = call.remoteStream;
        } catch (e) {
          console.warn('Could not directly include stream object:', e.message);
        }
        
        console.log('Found remote stream directly on call object');
      } else if (answerResult && answerResult.remoteStream) {
        // Include more stream details from the answer result
        remoteStreamInfo = {
          id: answerResult.remoteStream.id,
          active: answerResult.remoteStream.active,
          type: 'remote',
          tracks: Array.isArray(answerResult.remoteStream.getTracks) ?
            answerResult.remoteStream.getTracks().map(t => ({
              kind: t.kind,
              id: t.id,
              enabled: t.enabled
            })) : []
        };
        
        // Add a direct reference to the stream object if possible
        try {
          remoteStreamInfo.stream = answerResult.remoteStream;
        } catch (e) {
          console.warn('Could not directly include stream object from answer result:', e.message);
        }
        
        console.log('Found remote stream in answer result');
      } else if (call.media && call.media.remoteSdp) {
        // Try to extract from SDP if available
        console.log('Remote SDP available, creating stream reference');
        remoteStreamInfo = {
          sdp: call.media.remoteSdp,
          type: 'sdp'
        };
      }
      
      // Log detailed stream info for debugging
      if (remoteStreamInfo) {
        console.log('Found remote stream info:', JSON.stringify({
          id: remoteStreamInfo.id,
          type: remoteStreamInfo.type,
          active: remoteStreamInfo.active,
          hasTracks: remoteStreamInfo.tracks ? remoteStreamInfo.tracks.length > 0 : false,
          hasStream: !!remoteStreamInfo.stream,
          hasSdp: !!remoteStreamInfo.sdp
        }));
        
        // Forward the stream info to the client
        io.emit('mediaChanges', {
          callId: call.id,
          remoteStream: remoteStreamInfo
        });
      } else {
        console.warn('No remote stream found immediately after answering');
      }
      
      // Set up media event listeners if available
      if (call.on && typeof call.on === 'function') {
        try {
          // Log all events for debugging
          call.on('all', (eventType, event) => {
            console.log(`Call event received: ${eventType}`, 
              eventType === 'track' ? {trackKind: event.track?.kind, trackId: event.track?.id} : 
              (eventType === 'media.streaming' ? {hasRemoteStream: !!event.remoteStream} : {})
            );
          });
          
          // Listen for media streaming events
          call.on('media.streaming', (event) => {
            console.log('Media streaming event received:', JSON.stringify({
              callId: call.id,
              eventType: 'media.streaming',
              hasRemoteStream: !!event.remoteStream,
              hasStream: !!event.stream
            }));
            
            const safeStreamEvent = {
              callId: call.id,
              eventType: 'media.streaming'
            };
            
            if (event.remoteStream) {
              safeStreamEvent.remoteStream = {
                id: event.remoteStream.id,
                active: event.remoteStream.active,
                type: 'remote'
              };
              
              // Try to include the direct stream
              try {
                safeStreamEvent.remoteStream.stream = event.remoteStream;
              } catch (e) {
                console.warn('Could not include direct remote stream in event:', e.message);
              }
            } else if (event.stream) {
              safeStreamEvent.remoteStream = {
                id: event.stream.id,
                active: event.stream.active,
                type: 'stream'
              };
              
              // Try to include the direct stream
              try {
                safeStreamEvent.remoteStream.stream = event.stream;
              } catch (e) {
                console.warn('Could not include direct stream in event:', e.message);
              }
            }
            
            // Forward media streaming event to client
            io.emit('mediaChanges', safeStreamEvent);
          });
          
          // Also listen for track events which might have media
          call.on('track', (event) => {
            console.log('Track event received:', event.track.kind);
            
            if (event.track.kind === 'audio') {
              const trackEvent = {
                callId: call.id,
                eventType: 'track',
                remoteStream: {
                  id: event.track.id,
                  kind: event.track.kind,
                  type: 'track'
                }
              };
              
              // Forward track event to client
              io.emit('mediaChanges', trackEvent);
            }
          });

          // Listen for SDP events which might have audio info
          call.on('media.sdp', (event) => {
            console.log('SDP event received');
            
            if (event.remoteSdp) {
              const sdpEvent = {
                callId: call.id,
                eventType: 'sdp',
                remoteStream: {
                  type: 'sdp',
                  sdp: event.remoteSdp
                }
              };
              
              // Forward SDP to client
              io.emit('mediaChanges', sdpEvent);
            }
          });
          
          console.log('Media event listeners set up successfully');
        } catch (err) {
          console.warn('Could not set up media event listeners:', err.message);
        }
      }
      
      // Notify client of call status
      io.emit('callActive', { 
        callId: call.id,
        state: call.state 
      });
      
      socket.emit('callAnswered', { 
        callId: call.id,
        status: 'Call Active',
        remoteStream: remoteStreamInfo
      });
      
      // Send explicit command to enable audio output
      setTimeout(() => {
        io.emit('enableAudioOutput', {
          callId: call.id,
          forceAudio: true
        });
      }, 1000);
      
    } catch (error) {
      console.error('Error answering call:', error);
      socket.emit('callError', { 
        callId: data.callId,
        error: error.message
      });
    }
  });
  
  socket.on('hangupCall', async (data) => {
    console.log('Hanging up call:', data.callId);
    
    // Check if it's a call we know about from the realtime API or webhook
    const call = activeCalls.get(data.callId) || webhookCalls.get(data.callId);
    if (!call) {
      console.log('Call not found for hangup - it may have already ended');
      
      // Still notify clients to clean up UI
      handleCallEnded(data.callId);
      return;
    }
    
    try {
      console.log('Attempting to hang up call with ID:', data.callId);
      
      // Check if call is in a valid state to hang up
      const validHangupStates = ['created', 'ringing', 'answered', 'active'];
      const canHangup = validHangupStates.includes(call.state);
      
      if (canHangup) {
        // Attempt to hang up the call via SignalWire
        try {
          const result = await call.hangup();
          console.log('Hangup result:', result);
        } catch (hangupError) {
          // If we get a 404, the call is already gone on SignalWire's side
          if (hangupError.code === '404') {
            console.log('Call already ended on SignalWire side');
          } else {
            console.error('Error from SignalWire while hanging up:', hangupError);
          }
        }
      } else {
        console.log(`Call in state ${call.state} cannot be hung up`);
      }
      
      // Always clean up resources
      handleCallEnded(data.callId);
    } catch (error) {
      console.error('Error in hangup process:', error);
      
      // Still clean up resources even if hangup fails
      handleCallEnded(data.callId);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  // Handle ping from client to keep connection alive
  socket.on('ping', (data) => {
    // Respond with a pong containing the original timestamp to help measure latency
    socket.emit('pong', { 
      callId: data.callId,
      originalTimestamp: data.timestamp,
      serverTimestamp: Date.now()
    });
  });
  
  // Handle call status check requests
  socket.on('checkCallStatus', (data) => {
    console.log('Client requested status check for call:', data.callId);
    
    const call = activeCalls.get(data.callId) || webhookCalls.get(data.callId);
    if (!call) {
      console.log('Call not found during status check - notifying client that call has ended');
      handleCallEnded(data.callId);
      return;
    }
    
    // If call exists but is in an ended state
    if (['ended', 'ending', 'completed', 'busy', 'failed', 'canceled'].includes(call.state)) {
      console.log(`Call ${data.callId} is in end state (${call.state}) during status check, cleaning up`);
      handleCallEnded(data.callId);
      return;
    }
    
    // Call is still active, send current state
    socket.emit('callStatus', {
      callId: call.id,
      state: call.state,
      active: true
    });
  });
});

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add audio test page route
app.get('/audio-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'webrtc-audio-test.html'));
});

// Debug route to check environment variables
app.get('/debug/env', (req, res) => {
  res.json({
    project: process.env.PROJECT_ID ? 'Set (length: ' + process.env.PROJECT_ID.length + ')' : 'Not set',
    token: process.env.TOKEN ? 'Set (length: ' + process.env.TOKEN.length + ')' : 'Not set',
    space_url: process.env.SPACE_URL || 'Not set',
    phone_number: process.env.PHONE_NUMBER || 'Not set',
    public_url: process.env.PUBLIC_URL || 'Not set'
  });
});

// Enhanced event handling for the webhook route
app.post('/webhook/status', (req, res) => {
  console.log('Received webhook:', JSON.stringify(req.body, null, 2));
  
  const callEvent = req.body;
  if (!callEvent || !callEvent.event || !callEvent.params) {
    console.log('Invalid webhook data');
    return res.status(400).send('Invalid webhook data');
  }
  
  const callId = callEvent.params.call_id;
  const eventType = callEvent.event;
  
  console.log(`Webhook event: ${eventType} for call ${callId}`);
  
  if (eventType === 'call.ended' || eventType === 'call.completed' || 
      eventType === 'call.failed' || eventType === 'call.busy') {
    console.log(`Call ${callId} ended via webhook notification`);
    handleCallEnded(callId);
  }
  
  res.status(200).send('Webhook received');
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
  console.log(`Environment: NODE_ENV=${process.env.NODE_ENV}`);
  console.log(`Webhook URL: ${process.env.PUBLIC_URL || 'http://localhost:'+PORT}/webhook/status`);
  
  // Start SignalWire client after server is running
  startSignalWireClient();
  startCallStatePolling(); // Start the call state polling
});

// Start the SignalWire client and set up event handlers
async function startSignalWireClient() {
  try {
    console.log('Initializing SignalWire client...');
    console.log(`Project ID: ${process.env.PROJECT_ID ? '******' + process.env.PROJECT_ID.slice(-6) : 'Not set'}`);
    console.log(`Token: ${process.env.TOKEN ? '******' + process.env.TOKEN.slice(-6) : 'Not set'}`);
    
    // Initialize SignalWire client with v4 syntax
    signalwireClient = await SignalWire({
      project: process.env.PROJECT_ID,
      token: process.env.TOKEN,
      topics: ['office', 'default']  // Listen for both office and default contexts
    });
    
    console.log('Connected to SignalWire successfully');
    
    // Get the voice client
    voiceClient = signalwireClient.voice;
    console.log('Voice client initialized');
    
    // Listen for incoming calls
    console.log('Setting up call listener for topics: office, default');
    voiceClient.listen({
      topics: ['office', 'default'],
      onCallReceived: async (call) => {
        console.log('------------ INCOMING CALL RECEIVED ------------');
        console.log('Call ID:', call.id);
        console.log('From:', call.from);
        console.log('To:', call.to);
        console.log('State:', call.state);
        console.log('-----------------------------------------------');
        
        // Store the call reference
        activeCalls.set(call.id, call);
        console.log('Active calls:', Array.from(activeCalls.keys()));
        
        // Setup call state change event handlers
        try {
          // Handle state changes - this catches when caller hangs up
          call.on('state', event => {
            console.log(`Call ${call.id} state changed to:`, event.call.state);
            
            // If the call has ended (caller hung up)
            if (['ended', 'ending', 'completed', 'busy', 'failed', 'canceled'].includes(event.call.state)) {
              console.log(`Call ${call.id} has been terminated with state: ${event.call.state}`);
              handleCallEnded(call.id);
            }
          });
          
          // Listen specifically for hangup events from SignalWire
          call.on('call.ended', event => {
            console.log(`Call ${call.id} ended event received from SignalWire`);
            handleCallEnded(call.id);
          });
          
          // Also listen for other call events for better diagnostics
          call.on('call.answered', event => {
            console.log(`Call ${call.id} was answered`, event);
          });
          
          call.on('call.failed', event => {
            console.log(`Call ${call.id} failed`, event);
            handleCallEnded(call.id);
          });
          
          console.log('Call event handlers set up successfully');
        } catch (err) {
          console.warn('Error setting up call event handlers:', err.message);
        }
        
        // Notify clients
        io.emit('incomingCall', {
          callId: call.id,
          from: call.from,
          to: call.to
        });
      }
    });
    
    console.log('Call listener set up successfully');
    
  } catch (error) {
    console.error('Error starting SignalWire client:', error);
  }
} 