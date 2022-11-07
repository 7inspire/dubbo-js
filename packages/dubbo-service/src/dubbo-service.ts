/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import net, { Socket } from 'node:net'
import debug from 'debug'
import compose, { Middleware } from 'koa-compose'
import { Retry, util, d$ } from 'apache-dubbo-common'
import {
  DecodeBuffer,
  HeartBeat,
  Hessian2Decoder,
  Hessian2Encoder,
  Request
} from 'apache-dubbo-serialization'
import Context from './context'
import { portManager } from './port'
import * as s from './dubbo-setting'
import {
  DubboServiceClazzName,
  IDubboServerProps,
  IDubboService,
  IRegistry
} from './types'

const log = debug('dubbo-server')

/**
 * DubboServer - expose dubbo service by nodejs
 * - expose dubbo service
 * - connect zookeeper or nacos, registry service
 * - router => find service
 * - extend middleware
 * - keep heartbeat with consumer
 */

export default class DubboService {
  private readonly readyPromise: Promise<void>
  private readonly application: { name: string }
  private readonly dubbo: string
  // service invoke chain middlewares
  private readonly middlewares: Array<Middleware<Context>>
  // register service
  private readonly services: { [name in string]: IDubboService }
  // dubbo service setting
  private readonly dubboSetting: s.DubboSetting

  // resolve ready promise
  private resolve: Function
  // reject ready promise
  private reject: Function

  private encoder: Hessian2Encoder
  private decoder: Hessian2Decoder

  private retry: Retry
  private port: number
  private server: net.Server
  private registry: IRegistry
  private serviceRouter: Map<DubboServiceClazzName, Array<IDubboService>>

  constructor(props: IDubboServerProps) {
    // check props
    DubboService.checkProps(props)

    // set application name
    this.application = props.application
    this.dubbo = props.dubbo

    this.encoder = new Hessian2Encoder()
    this.decoder = new Hessian2Decoder()

    // init ready promise
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })

    // init dubbo setting
    this.dubboSetting = props.dubboSetting || s.Setting()

    // init registry
    this.registry = props.registry

    // init service
    this.serviceRouter = new Map()
    this.services = props.services

    // init middlewares
    this.middlewares = []

    // set retry container
    this.retry = new Retry({
      retry: () => this.serve(),
      end: () => {
        throw new Error(
          'Oops, dubbo server can not start, can not find available port'
        )
      }
    })

    process.nextTick(async () => {
      // listen tcp server
      await this.serve()
    })
  }

  // ~~~~~~~~~~~~~~~~~~private~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  private static checkProps(props: IDubboServerProps) {
    if (!util.isObj(props.registry)) {
      throw new Error(`Please specify registry, use Zk or Nacos init registry`)
    }

    if (!util.isObj(props.services)) {
      throw new Error(`Please specify dubbo service`)
    }
  }

  /**
   * start tcp server
   */
  private serve = async () => {
    this.port = await portManager.getReusedPort()
    log(`init service with port: %d`, this.port)

    this.server = net
      .createServer(this.handleTcpRequest)
      .listen(this.port, () => {
        log('start dubbo-server with port %d', this.port)
        this.retry.reset()
        this.registerServices().catch((err) =>
          log(`register service error ${err.message}`)
        )
      })
      .on('error', (err) => {
        log(`server listen %d port err: %s`, this.port, err)
        try {
          this.retry.start()
        } catch (err) {
          this.reject(err)
        }
      })
  }

  /**
   * receive tcp message
   * @param socket
   */
  private handleTcpRequest = (socket: Socket) => {
    log('tcp socket establish connection %s', socket.remoteAddress)

    // init heartbeat
    const heartbeat = HeartBeat.from({
      type: 'server',
      transport: socket,
      onTimeout: () => socket.destroy()
    })

    DecodeBuffer.from(socket, 'dubbo-server').subscribe(async (data) => {
      // send heartbeat
      if (HeartBeat.isHeartBeat(data)) {
        log(`receive socket client heartbeat`)
        // emit heartbeat from server
        heartbeat.emit()
        return
      }

      const ctx = await this.invokeComposeChainRequest(data)
      heartbeat.setWriteTimestamp()
      socket.write(this.encoder.encodeDubboResponse(ctx))
    })
  }

  /**
   * invoke compose middleware chain, the same as koa
   * @param data
   * @returns
   */
  private async invokeComposeChainRequest(data: Buffer) {
    const request = this.decoder.decodeDubboRequest(data)
    log('receive request %O', request)
    const service = this.matchService(request)
    const ctx = new Context(request)

    const {
      methodName,
      attachment: { path, group = '', version }
    } = request

    // service not found
    if (!service) {
      log(
        `Service not found with ${path} and ${methodName}, group:${group}, version:${version}`
      )
      ctx.status = d$.DUBBO_RESPONSE_STATUS.SERVICE_NOT_FOUND
      ctx.body.err = new Error(
        `Service not found with ${path} and ${methodName}, group:${group}, version:${version}`
      )
      return ctx
    }

    const middlewares = [
      ...this.middlewares,
      async function handleRequest(ctx: Context) {
        const method = service.methods[request.methodName]
        ctx.status = d$.DUBBO_RESPONSE_STATUS.OK
        try {
          // FIXME waiting dubbo/dj
          // check hessian type
          // if (!util.checkRetValHessian(res)) {
          //   ctx.body.err = new Error(
          //     `${path}#${methodName} return value not hessian type`
          //   )
          //   return
          // }
          ctx.body.res = await method.apply(service, [
            ...(request.args || []),
            ctx
          ])
        } catch (err) {
          log(`handle request error %s`, err)
          ctx.body.err = err
        }
      }
    ]

    log('middleware stack =>', middlewares)
    const fn = compose(middlewares)

    try {
      await fn(ctx)
    } catch (err) {
      log(err)
      ctx.status = d$.DUBBO_RESPONSE_STATUS.SERVER_ERROR
      ctx.body.err = err
    }

    return ctx
  }

  /**
   * register service into zookeeper or nacos
   */
  private async registerServices() {
    const services = [] as Array<IDubboService>

    for (let [id, service] of Object.entries(this.services)) {
      const meta = this.dubboSetting.getDubboSetting({
        dubboServiceShortName: id,
        dubboServiceInterface: service.dubboInterface
      })
      service.group = meta.group
      service.version = meta.version

      // collect service router
      if (this.serviceRouter.has(service.dubboInterface)) {
        this.serviceRouter.get(service.dubboInterface).push(service)
      } else {
        this.serviceRouter.set(service.dubboInterface, [service])
      }

      services.push(service)
    }

    // register service to registry, such as zookeeper or nacos
    await this.registry.registerServices({
      application: this.application,
      port: this.port,
      dubbo: this.dubbo,
      services
    })

    // everything ready...
    this.resolve()
  }

  /**
   * router, map request to service
   * @param request
   * @returns
   */
  private matchService(request: Request) {
    const { methodName } = request
    const {
      attachment: { path, group = '', version = '0.0.0' }
    } = request

    const serviceList = this.serviceRouter.get(path) || []
    return serviceList.find((s) => {
      const isSameVersion = version == '*' || s.version === version
      const isSameGroup = group === s.group
      return s.methods[methodName] && isSameGroup && isSameVersion
    })
  }

  // ~~~~~~~~~~~~~public method ~~~~~~~~~~~~~~~~~~~

  /**
   * static factory method
   *
   * @param props
   * @returns
   */
  public static from(props: IDubboServerProps) {
    return new DubboService(props)
  }

  /**
   * close current tcp service
   */
  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.registry.close()
      this.server.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * extends middleware
   *
   * @param fn
   */
  public use(fn: Middleware<Context>) {
    if (typeof fn != 'function') {
      throw new TypeError('middleware must be a function')
    }
    log('use middleware %s', (fn as any)._name || fn.name || '-')
    this.middlewares.push(fn)
    return this
  }

  public ready() {
    return this.readyPromise
  }

  public getPort() {
    return this.port
  }
}
