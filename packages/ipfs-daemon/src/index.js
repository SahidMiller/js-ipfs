'use strict'

const log = require('debug')('ipfs:daemon')
const set = require('just-safe-set')
const http = require('http')
// @ts-ignore - no types
const WebRTCStar = require('libp2p-webrtc-star')
const IPFS = require('ipfs-core')
const HttpApi = require('ipfs-http-server')
const HttpGateway = require('ipfs-http-gateway')
const gRPCServer = require('ipfs-grpc-server')
const { isElectron } = require('ipfs-utils/src/env')
// @ts-ignore no types
const toMultiaddr = require('uri-to-multiaddr')

/**
 * @typedef {import('ipfs-core-types').IPFS} IPFS
 * @typedef {import('./types').Server} Server
 * @typedef {import('libp2p')} libp2p
 */

/**
 * @param {import('@hapi/hapi').ServerInfo} info
 */
function hapiInfoToMultiaddr (info) {
  let hostname = info.host
  let uri = info.uri
  // ipv6 fix
  if (hostname.includes(':') && !hostname.startsWith('[')) {
    // hapi 16 produces invalid URI for ipv6
    // we fix it here by restoring missing square brackets
    hostname = `[${hostname}]`
    uri = uri.replace(`://${info.host}`, `://${hostname}`)
  }
  return toMultiaddr(uri)
}

/**
 * @param {string | string[]} serverAddrs
 * @param {(host: string, port: string, ipfs: IPFS, opts: Record<string, any>) => Promise<Server>} createServer
 * @param {IPFS} ipfs
 * @param {Record<string, any>} opts
 */
async function serverCreator (serverAddrs, createServer, ipfs, opts = {}) {
  serverAddrs = serverAddrs || []
  // just in case the address is just string
  serverAddrs = Array.isArray(serverAddrs) ? serverAddrs : [serverAddrs]

  /** @type {Server[]} */
  const servers = []
  for (const address of serverAddrs) {
    const addrParts = address.split('/')
    const isLibp2p = addrParts[1] === "libp2p"

    if (!isLibp2p) {
      const server = await createServer(addrParts[2], addrParts[4], ipfs, opts)
      server.info.ma = hapiInfoToMultiaddr(server.info)
      await server.start()
      servers.push(server)
      return
    }
    
    // /libp2p/<protocol-name>
    const protocol = addrParts[2]
    //call hapi with autoListen + listener to pass custom options to server.listen
    const listener = new http.Server();

    const server = await createServer("libp2p", protocol, ipfs, {
      ...opts,
      host: undefined,
      port: undefined,
      autoListen: false,
      listener
    })
    
    //@ts-ignore
    listener.listen({ protocol: addrParts[2], libp2p: ipfs.libp2p })

    const { id } = await ipfs.id()
    server.info.ma = `/libp2p/${id}/${protocol}`
    await server.start()
    servers.push(server)
  }

  return servers
}

class Daemon {
  /**
   * @param {import('ipfs-core').Options} options
   */
  constructor (options = {}) {
    this._options = options

    if (process.env.IPFS_MONITORING) {
      // Setup debug metrics collection
      const prometheusClient = require('prom-client')
      // @ts-ignore - no types
      const prometheusGcStats = require('prometheus-gc-stats')
      const collectDefaultMetrics = prometheusClient.collectDefaultMetrics
      // @ts-ignore - timeout isn't in typedefs
      collectDefaultMetrics({ timeout: 5000 })
      prometheusGcStats(prometheusClient.register)()
    }
  }

  /**
   * Starts the IPFS HTTP server
   */
  async start () {
    log('starting')

    // start the daemon
    this._ipfs = await IPFS.create(
      Object.assign({}, { start: true, libp2p: getLibp2p }, this._options)
    )
    
    // start HTTP servers (if API or Gateway is enabled in options)
    this._httpApi = new HttpApi(this._ipfs)
    await this._httpApi.start({ serverCreator })

    this._httpGateway = new HttpGateway(this._ipfs)
    await this._httpGateway.start({ serverCreator })

    const config = await this._ipfs.config.getAll()

    if (config.Addresses && config.Addresses.RPC) {
      this._grpcServer = await gRPCServer(this._ipfs)
    }

    log('started')
  }

  async stop () {
    log('stopping')

    await Promise.all([
      this._httpApi && this._httpApi.stop(),
      this._httpGateway && this._httpGateway.stop(),
      this._grpcServer && this._grpcServer.stop(),
      this._ipfs && this._ipfs.stop()
    ])

    log('stopped')
  }
}

/**
 * @type {import('ipfs-core/src/types').Libp2pFactoryFn}
 */
function getLibp2p ({ libp2pOptions, options, config, peerId }) {
  // Attempt to use any of the WebRTC versions available globally
  let electronWebRTC
  let wrtc
  const hasWebRTCStar =
  libp2pOptions.modules.transport.findIndex((t) => t.isWebRTCStar) !== -1;

  if (!hasWebRTCStar) {
    if (isElectron) {
      try {
        // @ts-ignore - cant find type info
        electronWebRTC = require('electron-webrtc')()
      } catch (err) {
        log('failed to load optional electron-webrtc dependency')
      }
    }

    if (!electronWebRTC) {
      try {
        // @ts-ignore - cant find type info
        wrtc = require('wrtc')
      } catch (err) {
        log('failed to load optional webrtc dependency')
      }
    }

    if (wrtc || electronWebRTC) {
      log(`Using ${wrtc ? 'wrtc' : 'electron-webrtc'} for webrtc support`)
      set(libp2pOptions, 'config.transport.WebRTCStar.wrtc', wrtc || electronWebRTC)
      libp2pOptions.modules.transport.push(WebRTCStar)
    }
  }

  const Libp2p = require('libp2p')
  return new Libp2p(libp2pOptions)
}

module.exports = Daemon
