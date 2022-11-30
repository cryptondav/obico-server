import get from 'lodash/get'

import Janus from '@src/lib/janus'

let printerWebRTCUrl = printerId => `/ws/janus/${printerId}/`
let printerSharedWebRTCUrl = token => `/ws/share_token/janus/${token}/`

export default function WebRTCConnection() {
  let self = {
    callbacks: {},
    initialized: false,
    defaultWebRTCConn: DefaultWebRTCConnection(),
    mjpegWebRTCConn: DefaultWebRTCConnection(),

    openForShareToken(shareToken) {
      self.connect(
        printerSharedWebRTCUrl(shareToken),
        shareToken
      )
    },

    openForPrinter(printerId, authToken) {
      self.connect(
        printerWebRTCUrl(printerId),
        authToken
      )
    },
    connect(wsUri, token) {
      self.initialized = true
      self.defaultWebRTCConn.connect(wsUri, token)
      self.mjpegWebRTCConn.connect(wsUri, token)
    },
    stopStream() {
      self.defaultWebRTCConn.stopStream()
      self.mjpegWebRTCConn.stopStream()
    },
    sendData(data) {
      self.defaultWebRTCConn.sendData(data)
    },
    startStream() {
      self.defaultWebRTCConn.stopStream()
      self.mjpegWebRTCConn.stopStream()
    },
    setCallbacks(callbacks) {
      self.callbacks = {...self.callbacks, ...callbacks}
      self.defaultWebRTCConn.setCallbacks(self.callbacks)
      self.mjpegWebRTCConn.setCallbacks(self.callbacks)
    }
  }
  return self
}

function DefaultWebRTCConnection() {
  let self = {
    callbacks: {},
    streamId: undefined,
    streaming: undefined,
    bitrateInterval: null,

    setCallbacks(callbacks) {
      self.callbacks = callbacks
    },

    connect(wsUri, token) {
      Janus.init({
        debug: 'all',
        callback: () => {
          if (!Janus.isWebrtcSupported()) {
            return
          }
          self.connectJanusWebSocket(wsUri, token)
        }
      })
    },

    connectJanusWebSocket(wsUri, token) {
      const opaqueId = 'streamingtest-' + Janus.randomString(12)

      var iceServers = [{urls:['stun:stun.l.google.com:19302']}]
      if (token) {
        var turnServer = window.location.hostname.replace('app', 'turn')
        iceServers.push(
          {
            urls:'turn:' + turnServer + ':80?transport=udp',
            credential: token,
            username: token
          })
        iceServers.push(
          {
            urls:'turn:' + turnServer + ':80?transport=tcp',
            credential: token,
            username: token
          })
      }

      var janus = new Janus({
        server: window.location.protocol.replace('http', 'ws') + '//' + window.location.host + wsUri,
        iceServers: iceServers,
        ipv6: true,
        success: () => {
          janus.attach(
            {
              plugin: 'janus.plugin.streaming',
              opaqueId: opaqueId,
              success: function (pluginHandle) {
                Janus.log('Plugin attached! (' + pluginHandle.getPlugin() + ', id=' + pluginHandle.getId() + ')')

                const body = { 'request': 'info', id: 0 }
                Janus.debug('Sending message (' + JSON.stringify(body) + ')')
                pluginHandle.send({
                  'message': body, success: function (result) {
                    let stream = get(result, 'info')
                    if (stream) {
                      self.streamId = stream.id
                      self.streaming = pluginHandle
                      if (get(stream, 'video')) {
                        self.callbacks.onStreamAvailable()
                      }
                    }
                  }
                })
              },
              error: function (error) {
                Janus.error('  -- Error attaching plugin... ', error)
                janus.destroy()
              },
              onmessage: function(msg, jsep) {
                self.onMessage(msg, jsep)
              },
              onremotestream: function(stream) {
                Janus.debug(' ::: Got a remote stream :::')
                Janus.debug(stream)
                if ('onRemoteStream' in self.callbacks) {
                  self.callbacks.onRemoteStream(stream)
                }
              },
              ontrackmuted: function() {
                if ('onTrackMuted' in self.callbacks) {
                  self.callbacks.onTrackMuted()
                }
              },
              ontrackunmuted: function() {
                if ('onTrackUnmuted' in self.callbacks) {
                  self.callbacks.onTrackUnmuted()
                }
              },
              slowLink: function(uplink, lost) {
                if ('onSlowLink' in self.callbacks) {
                  self.callbacks.onSlowLink(lost)
                }
              },
              ondataopen: function() {
              },
              ondata: function(rawData) {
                if ('onData' in self.callbacks) {
                  self.callbacks.onData(rawData)
                }
              },
              oncleanup: function() {
                if ('onCleanup' in self.callbacks) {
                  self.callbacks.onCleanup()
                }
              }
            })
        },
        error(e) {
          Janus.error('  -- Error -- ', e)
          janus.destroy()
        },
        destroyed() {
          self.streaming = undefined
          self.streamId = undefined
          self.clearBitrateInterval()
        }
      })
    },
    onMessage(msg, jsep) {
      let self = this
      Janus.debug(' ::: Got a message :::')
      Janus.debug(msg)
      let result = msg['result']
      if (result !== null && result !== undefined) {
        if (result['status'] !== undefined && result['status'] !== null) {
          var status = result['status']
          if (status === 'starting')
            console.log('Starting')
          else if (status === 'started')
            console.log('Started')
          else if (status === 'stopped') {
            self.stopStream()
          }
        }
      } else if (msg['error'] !== undefined && msg['error'] !== null) {
        Janus.error(msg)
        self.stopStream()
        return
      }
      if (jsep !== undefined && jsep !== null) {
        // Offer from the plugin, let's answer
        self.streaming?.createAnswer(
          {
            jsep: jsep,
            // We want recvonly audio/video and, if negotiated, datachannels
            media: { audioSend: false, videoSend: false, data: true },
            success: function (jsep) {
              Janus.debug('Got SDP!')
              Janus.debug(jsep)
              var body = { 'request': 'start' }
              self.streaming?.send({ 'message': body, 'jsep': jsep })
            },
            error: function (error) {
              Janus.error('WebRTC error:', error)
            }
          })
      }
    },
    channelOpen() {
      return !(self.streamId === undefined || self.streaming === undefined)
    },
    startStream() {
      if (!self.channelOpen()) {
        return
      }
      const body = { 'request': 'watch', offer_video: true, id: parseInt(self.streamId) }
      self.streaming?.send({ 'message': body })

      self.clearBitrateInterval()
      self.bitrateInterval = setInterval(function() {
        if (self.streaming) {
          const bitrate = self.streaming.getBitrate()
          if (bitrate && bitrate.value) {
            self.callbacks.onBitrateUpdated(self.streaming.getBitrate())
          } else {
            self.callbacks.onBitrateUpdated({value: null})
          }
        } else {
          self.callbacks.onBitrateUpdated({value: null})
        }
      }, 5000)
    },
    stopStream() {
      self.clearBitrateInterval()
      if (!self.channelOpen()) {
        return
      }
      const body = { 'request': 'stop' }
      self.streaming?.send({ 'message': body })
      self.streaming?.hangup()
    },

    sendData(data) {
      if (self.channelOpen()) {
        self.streaming?.data({text: data, success: () => {}})
      }
    },

    clearBitrateInterval() {
      if (self.bitrateInterval) {
        clearInterval(self.bitrateInterval)
        self.bitrateInterval = null
        self.callbacks.onBitrateUpdated({value: null})
      }
    }
  }

  return self
}
