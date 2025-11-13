const config = require('../../config/config')
const logger = require('../utils/logger')

// 时区辅助函数（保持不变）
function getDateInTimezone(date = new Date()) {
  const offset = config.system.timezoneOffset || 8
  const offsetMs = offset * 3600000
  const adjustedTime = new Date(date.getTime() + offsetMs)
  return adjustedTime
}

function getDateStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  return `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
    tzDate.getUTCDate()
  ).padStart(2, '0')}`
}

function getHourInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  return tzDate.getUTCHours()
}

function getWeekStringInTimezone(date = new Date()) {
  const tzDate = getDateInTimezone(date)
  const year = tzDate.getUTCFullYear()
  const dateObj = new Date(tzDate)
  const dayOfWeek = dateObj.getUTCDay() || 7
  const firstThursday = new Date(dateObj)
  firstThursday.setUTCDate(dateObj.getUTCDate() + 4 - dayOfWeek)
  const yearStart = new Date(firstThursday.getUTCFullYear(), 0, 1)
  const weekNumber = Math.ceil(((firstThursday - yearStart) / 86400000 + 1) / 7)
  return `${year}-W${String(weekNumber).padStart(2, '0')}`
}

/**
 * 内存版 Redis 客户端
 * 使用 JavaScript Map 和对象存储数据，完全兼容原有 Redis 接口
 */
class MemoryRedisClient {
  constructor() {
    this.isConnected = false
    // 主存储：Map<string, any>
    this.store = new Map()
    // TTL 存储：Map<string, timestamp>
    this.ttls = new Map()
    // 哈希表存储：Map<key, Map<field, value>>
    this.hashes = new Map()
    // 列表存储：Map<key, Array>
    this.lists = new Map()
    // 有序集合存储：Map<key, Map<member, score>>
    this.zsets = new Map()

    // 启动 TTL 清理任务
    this._startTTLCleaner()

    logger.info('🧠 Memory Redis Client initialized (in-memory mode)')
  }

  // 启动 TTL 清理器（每分钟清理一次过期键）
  _startTTLCleaner() {
    setInterval(() => {
      const now = Date.now()
      let cleaned = 0

      // 清理普通键
      for (const [key, expireTime] of this.ttls.entries()) {
        if (expireTime <= now) {
          this.store.delete(key)
          this.hashes.delete(key)
          this.lists.delete(key)
          this.zsets.delete(key)
          this.ttls.delete(key)
          cleaned++
        }
      }

      if (cleaned > 0) {
        logger.debug(`🧹 Cleaned ${cleaned} expired keys from memory`)
      }
    }, 60000) // 每分钟清理一次
  }

  // 检查键是否过期
  _isExpired(key) {
    if (!this.ttls.has(key)) {
      return false
    }
    return this.ttls.get(key) <= Date.now()
  }

  // 设置键的过期时间
  _setExpiry(key, seconds) {
    if (seconds > 0) {
      this.ttls.set(key, Date.now() + seconds * 1000)
    }
  }

  async connect() {
    this.isConnected = true
    logger.info('✅ Memory Redis connected successfully (in-memory mode)')
    return this
  }

  async disconnect() {
    this.isConnected = false
    logger.info('👋 Memory Redis disconnected')
  }

  async ping() {
    if (!this.isConnected) {
      throw new Error('Memory Redis client is not connected')
    }
    return 'PONG'
  }

  getClient() {
    if (!this.isConnected) {
      logger.warn('⚠️ Memory Redis client is not connected')
      return null
    }
    return this
  }

  getClientSafe() {
    if (!this.isConnected) {
      throw new Error('Memory Redis client is not connected')
    }
    return this
  }

  // ==================== 基础 Redis 操作 ====================

  async get(key) {
    if (this._isExpired(key)) {
      this.store.delete(key)
      this.ttls.delete(key)
      return null
    }
    return this.store.get(key) || null
  }

  async set(key, value, ...args) {
    this.store.set(key, value)

    // 处理 EX/PX 参数
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'EX' && args[i + 1]) {
        this._setExpiry(key, parseInt(args[i + 1]))
      } else if (args[i] === 'PX' && args[i + 1]) {
        this.ttls.set(key, Date.now() + parseInt(args[i + 1]))
      } else if (args[i] === 'NX') {
        // SET NX: 只在键不存在时设置
        if (this.store.has(key) && !this._isExpired(key)) {
          return null
        }
        this.store.set(key, value)
        return 'OK'
      }
    }

    return 'OK'
  }

  async setex(key, ttl, value) {
    this.store.set(key, value)
    this._setExpiry(key, ttl)
    return 'OK'
  }

  async del(...keys) {
    let deleted = 0
    for (const key of keys) {
      if (this.store.delete(key)) deleted++
      this.hashes.delete(key)
      this.lists.delete(key)
      this.zsets.delete(key)
      this.ttls.delete(key)
    }
    return deleted
  }

  async keys(pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    const result = []

    // 从所有存储中收集键
    const allKeys = new Set([
      ...this.store.keys(),
      ...this.hashes.keys(),
      ...this.lists.keys(),
      ...this.zsets.keys()
    ])

    for (const key of allKeys) {
      if (!this._isExpired(key) && regex.test(key)) {
        result.push(key)
      }
    }

    return result
  }

  async expire(key, seconds) {
    if (
      !this.store.has(key) &&
      !this.hashes.has(key) &&
      !this.lists.has(key) &&
      !this.zsets.has(key)
    ) {
      return 0
    }
    this._setExpiry(key, seconds)
    return 1
  }

  async ttl(key) {
    if (!this.ttls.has(key)) {
      // 键不存在
      if (
        !this.store.has(key) &&
        !this.hashes.has(key) &&
        !this.lists.has(key) &&
        !this.zsets.has(key)
      ) {
        return -2
      }
      // 键存在但没有 TTL
      return -1
    }
    const remaining = Math.ceil((this.ttls.get(key) - Date.now()) / 1000)
    return remaining > 0 ? remaining : -2
  }

  async incrbyfloat(key, increment) {
    let current = parseFloat(await this.get(key)) || 0
    current += parseFloat(increment)
    await this.set(key, current.toString())
    return current
  }

  async incr(key) {
    let current = parseInt(await this.get(key)) || 0
    current += 1
    await this.set(key, current.toString())
    return current
  }

  // ==================== 哈希表操作 ====================

  async hset(key, ...args) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map())
    }
    const hash = this.hashes.get(key)

    // 支持两种调用方式：hset(key, field, value) 或 hset(key, object)
    if (args.length === 1 && typeof args[0] === 'object') {
      // hset(key, {field1: value1, field2: value2})
      for (const [field, value] of Object.entries(args[0])) {
        hash.set(field, String(value))
      }
    } else {
      // hset(key, field1, value1, field2, value2, ...)
      for (let i = 0; i < args.length; i += 2) {
        hash.set(args[i], String(args[i + 1]))
      }
    }

    return 1
  }

  async hget(key, field) {
    if (this._isExpired(key)) {
      this.hashes.delete(key)
      return null
    }
    const hash = this.hashes.get(key)
    return hash ? hash.get(field) || null : null
  }

  async hgetall(key) {
    if (this._isExpired(key)) {
      this.hashes.delete(key)
      return {}
    }
    const hash = this.hashes.get(key)
    if (!hash) return {}

    const result = {}
    for (const [field, value] of hash.entries()) {
      result[field] = value
    }
    return result
  }

  async hdel(key, ...fields) {
    const hash = this.hashes.get(key)
    if (!hash) return 0

    let deleted = 0
    for (const field of fields) {
      if (hash.delete(field)) deleted++
    }
    return deleted
  }

  async hincrby(key, field, increment) {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map())
    }
    const hash = this.hashes.get(key)
    const current = parseInt(hash.get(field)) || 0
    const newValue = current + parseInt(increment)
    hash.set(field, String(newValue))
    return newValue
  }

  // ==================== 列表操作 ====================

  async lpush(key, ...values) {
    if (!this.lists.has(key)) {
      this.lists.set(key, [])
    }
    const list = this.lists.get(key)
    list.unshift(...values)
    return list.length
  }

  async lrange(key, start, stop) {
    if (this._isExpired(key)) {
      this.lists.delete(key)
      return []
    }
    const list = this.lists.get(key)
    if (!list) return []

    // Redis 的 lrange 支持负数索引
    const length = list.length
    let realStart = start < 0 ? Math.max(0, length + start) : start
    let realStop = stop < 0 ? Math.max(0, length + stop) : stop

    return list.slice(realStart, realStop + 1)
  }

  async ltrim(key, start, stop) {
    const list = this.lists.get(key)
    if (!list) return 'OK'

    const trimmed = await this.lrange(key, start, stop)
    this.lists.set(key, trimmed)
    return 'OK'
  }

  // ==================== 有序集合操作 ====================

  async zadd(key, ...args) {
    if (!this.zsets.has(key)) {
      this.zsets.set(key, new Map())
    }
    const zset = this.zsets.get(key)

    // zadd(key, score1, member1, score2, member2, ...)
    for (let i = 0; i < args.length; i += 2) {
      const score = parseFloat(args[i])
      const member = args[i + 1]
      zset.set(member, score)
    }

    return 1
  }

  async zrem(key, ...members) {
    const zset = this.zsets.get(key)
    if (!zset) return 0

    let removed = 0
    for (const member of members) {
      if (zset.delete(member)) removed++
    }
    return removed
  }

  async zcard(key) {
    if (this._isExpired(key)) {
      this.zsets.delete(key)
      return 0
    }
    const zset = this.zsets.get(key)
    return zset ? zset.size : 0
  }

  async zscore(key, member) {
    const zset = this.zsets.get(key)
    if (!zset) return null
    const score = zset.get(member)
    return score !== undefined ? score : null
  }

  async zremrangebyscore(key, min, max) {
    const zset = this.zsets.get(key)
    if (!zset) return 0

    let removed = 0
    const minScore = min === '-inf' ? -Infinity : parseFloat(min)
    const maxScore = max === '+inf' ? Infinity : parseFloat(max)

    for (const [member, score] of zset.entries()) {
      if (score >= minScore && score <= maxScore) {
        zset.delete(member)
        removed++
      }
    }

    return removed
  }

  // ==================== Pipeline 操作 ====================

  pipeline() {
    const commands = []
    const self = this

    return {
      hset(...args) {
        commands.push({ method: 'hset', args })
        return this
      },
      hincrby(...args) {
        commands.push({ method: 'hincrby', args })
        return this
      },
      expire(...args) {
        commands.push({ method: 'expire', args })
        return this
      },
      set(...args) {
        commands.push({ method: 'set', args })
        return this
      },
      incrbyfloat(...args) {
        commands.push({ method: 'incrbyfloat', args })
        return this
      },
      hgetall(...args) {
        commands.push({ method: 'hgetall', args })
        return this
      },
      hget(...args) {
        commands.push({ method: 'hget', args })
        return this
      },
      zadd(...args) {
        commands.push({ method: 'zadd', args })
        return this
      },
      zrem(...args) {
        commands.push({ method: 'zrem', args })
        return this
      },
      zremrangebyscore(...args) {
        commands.push({ method: 'zremrangebyscore', args })
        return this
      },
      zcard(...args) {
        commands.push({ method: 'zcard', args })
        return this
      },
      zscore(...args) {
        commands.push({ method: 'zscore', args })
        return this
      },
      del(...args) {
        commands.push({ method: 'del', args })
        return this
      },
      lpush(...args) {
        commands.push({ method: 'lpush', args })
        return this
      },
      ltrim(...args) {
        commands.push({ method: 'ltrim', args })
        return this
      },
      pexpire(...args) {
        // pexpire: 毫秒级过期
        const [key, ms] = args
        commands.push({ method: 'expire', args: [key, Math.ceil(ms / 1000)] })
        return this
      },
      async exec() {
        const results = []
        for (const cmd of commands) {
          try {
            const result = await self[cmd.method](...cmd.args)
            results.push([null, result])
          } catch (error) {
            results.push([error, null])
          }
        }
        return results
      }
    }
  }

  // ==================== Multi 操作（事务） ====================

  multi() {
    return this.pipeline()
  }

  // ==================== Lua 脚本支持 ====================

  async eval(script, numKeys, ...args) {
    // 简化的 Lua 脚本执行
    // 根据脚本内容判断要执行的操作

    const keys = args.slice(0, numKeys)
    const argv = args.slice(numKeys)

    // 并发控制脚本
    if (script.includes('ZREMRANGEBYSCORE') && script.includes('ZADD')) {
      const key = keys[0]
      const member = argv[0]
      const expireAt = parseFloat(argv[1])
      const now = parseFloat(argv[2])
      const ttl = parseInt(argv[3])

      // 清理过期成员
      await this.zremrangebyscore(key, '-inf', now)
      // 添加新成员
      await this.zadd(key, expireAt, member)
      // 设置键过期
      if (ttl > 0) {
        this.ttls.set(key, Date.now() + ttl)
      }
      // 返回集合大小
      return await this.zcard(key)
    }

    // 分布式锁释放脚本
    if (script.includes('get') && script.includes('del') && script.includes('KEYS[1]')) {
      const key = keys[0]
      const value = argv[0]
      const current = await this.get(key)
      if (current === value) {
        await this.del(key)
        return 1
      }
      return 0
    }

    // 刷新并发租约脚本
    if (script.includes('ZSCORE') && script.includes('exists')) {
      const key = keys[0]
      const member = argv[0]
      const expireAt = parseFloat(argv[1])
      const now = parseFloat(argv[2])
      const ttl = parseInt(argv[3])

      await this.zremrangebyscore(key, '-inf', now)
      const exists = await this.zscore(key, member)

      if (exists !== null) {
        await this.zadd(key, expireAt, member)
        if (ttl > 0) {
          this.ttls.set(key, Date.now() + ttl)
        }
        return 1
      }
      return 0
    }

    // 减少并发计数脚本
    if (script.includes('ZREM') && script.includes('ZCARD')) {
      const key = keys[0]
      const member = argv[0]
      const now = parseFloat(argv[1])

      if (member) {
        await this.zrem(key, member)
      }
      await this.zremrangebyscore(key, '-inf', now)

      const count = await this.zcard(key)
      if (count <= 0) {
        await this.del(key)
        return 0
      }
      return count
    }

    logger.warn('⚠️ Unhandled Lua script, returning 0')
    return 0
  }

  // ==================== API Key 相关操作 ====================

  async setApiKey(keyId, keyData, hashedKey = null) {
    const key = `apikey:${keyId}`

    if (hashedKey) {
      if (!this.hashes.has('apikey:hash_map')) {
        this.hashes.set('apikey:hash_map', new Map())
      }
      this.hashes.get('apikey:hash_map').set(hashedKey, keyId)
    }

    await this.hset(key, keyData)
    await this.expire(key, 86400 * 365)
  }

  async getApiKey(keyId) {
    const key = `apikey:${keyId}`
    return await this.hgetall(key)
  }

  async deleteApiKey(keyId) {
    const key = `apikey:${keyId}`
    const keyData = await this.hgetall(key)

    if (keyData && keyData.apiKey) {
      await this.hdel('apikey:hash_map', keyData.apiKey)
    }

    return await this.del(key)
  }

  async getAllApiKeys() {
    const keys = await this.keys('apikey:*')
    const apiKeys = []

    for (const key of keys) {
      if (key === 'apikey:hash_map') continue

      const keyData = await this.hgetall(key)
      if (keyData && Object.keys(keyData).length > 0) {
        apiKeys.push({ id: key.replace('apikey:', ''), ...keyData })
      }
    }

    return apiKeys
  }

  async findApiKeyByHash(hashedKey) {
    const keyId = await this.hget('apikey:hash_map', hashedKey)
    if (!keyId) return null

    const keyData = await this.hgetall(`apikey:${keyId}`)
    if (keyData && Object.keys(keyData).length > 0) {
      return { id: keyId, ...keyData }
    }

    await this.hdel('apikey:hash_map', hashedKey)
    return null
  }

  // ==================== 使用统计相关操作 ====================

  _normalizeModelName(model) {
    if (!model || model === 'unknown') {
      return model
    }

    if (model.includes('.anthropic.') || model.includes('.claude')) {
      let normalized = model.replace(/^[a-z0-9-]+\./, '')
      normalized = normalized.replace('anthropic.', '')
      normalized = normalized.replace(/-v\d+:\d+$/, '')
      return normalized
    }

    return model.replace(/-v\d+:\d+$|:latest$/, '')
  }

  async incrementTokenUsage(
    keyId,
    tokens,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    ephemeral5mTokens = 0,
    ephemeral1hTokens = 0,
    isLongContextRequest = false
  ) {
    const key = `usage:${keyId}`
    const now = new Date()
    const today = getDateStringInTimezone(now)
    const tzDate = getDateInTimezone(now)
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const currentHour = `${today}:${String(getHourInTimezone(now)).padStart(2, '0')}`

    const daily = `usage:daily:${keyId}:${today}`
    const monthly = `usage:monthly:${keyId}:${currentMonth}`
    const hourly = `usage:hourly:${keyId}:${currentHour}`

    const normalizedModel = this._normalizeModelName(model)

    const modelDaily = `usage:model:daily:${normalizedModel}:${today}`
    const modelMonthly = `usage:model:monthly:${normalizedModel}:${currentMonth}`
    const modelHourly = `usage:model:hourly:${normalizedModel}:${currentHour}`

    const keyModelDaily = `usage:${keyId}:model:daily:${normalizedModel}:${today}`
    const keyModelMonthly = `usage:${keyId}:model:monthly:${normalizedModel}:${currentMonth}`
    const keyModelHourly = `usage:${keyId}:model:hourly:${normalizedModel}:${currentHour}`

    const minuteTimestamp = Math.floor(now.getTime() / 60000)
    const systemMinuteKey = `system:metrics:minute:${minuteTimestamp}`

    const finalInputTokens = inputTokens || 0
    const finalOutputTokens = outputTokens || (finalInputTokens > 0 ? 0 : tokens)
    const finalCacheCreateTokens = cacheCreateTokens || 0
    const finalCacheReadTokens = cacheReadTokens || 0

    const totalTokens =
      finalInputTokens + finalOutputTokens + finalCacheCreateTokens + finalCacheReadTokens
    const coreTokens = finalInputTokens + finalOutputTokens

    const pipeline = this.pipeline()

    // 核心统计
    pipeline.hincrby(key, 'totalTokens', coreTokens)
    pipeline.hincrby(key, 'totalInputTokens', finalInputTokens)
    pipeline.hincrby(key, 'totalOutputTokens', finalOutputTokens)
    pipeline.hincrby(key, 'totalCacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(key, 'totalCacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(key, 'totalAllTokens', totalTokens)
    pipeline.hincrby(key, 'totalEphemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(key, 'totalEphemeral1hTokens', ephemeral1hTokens)
    if (isLongContextRequest) {
      pipeline.hincrby(key, 'totalLongContextInputTokens', finalInputTokens)
      pipeline.hincrby(key, 'totalLongContextOutputTokens', finalOutputTokens)
      pipeline.hincrby(key, 'totalLongContextRequests', 1)
    }
    pipeline.hincrby(key, 'totalRequests', 1)

    // 每日统计
    pipeline.hincrby(daily, 'tokens', coreTokens)
    pipeline.hincrby(daily, 'inputTokens', finalInputTokens)
    pipeline.hincrby(daily, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(daily, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(daily, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(daily, 'allTokens', totalTokens)
    pipeline.hincrby(daily, 'requests', 1)
    pipeline.hincrby(daily, 'ephemeral5mTokens', ephemeral5mTokens)
    pipeline.hincrby(daily, 'ephemeral1hTokens', ephemeral1hTokens)

    // 每月统计
    pipeline.hincrby(monthly, 'tokens', coreTokens)
    pipeline.hincrby(monthly, 'inputTokens', finalInputTokens)
    pipeline.hincrby(monthly, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(monthly, 'cacheCreateTokens', finalCacheCreateTokens)
    pipeline.hincrby(monthly, 'cacheReadTokens', finalCacheReadTokens)
    pipeline.hincrby(monthly, 'allTokens', totalTokens)
    pipeline.hincrby(monthly, 'requests', 1)

    // 小时统计
    pipeline.hincrby(hourly, 'tokens', coreTokens)
    pipeline.hincrby(hourly, 'inputTokens', finalInputTokens)
    pipeline.hincrby(hourly, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(hourly, 'allTokens', totalTokens)
    pipeline.hincrby(hourly, 'requests', 1)

    // 模型统计
    pipeline.hincrby(modelDaily, 'inputTokens', finalInputTokens)
    pipeline.hincrby(modelDaily, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(modelDaily, 'allTokens', totalTokens)
    pipeline.hincrby(modelDaily, 'requests', 1)

    // Key模型统计
    pipeline.hincrby(keyModelDaily, 'inputTokens', finalInputTokens)
    pipeline.hincrby(keyModelDaily, 'outputTokens', finalOutputTokens)
    pipeline.hincrby(keyModelDaily, 'allTokens', totalTokens)
    pipeline.hincrby(keyModelDaily, 'requests', 1)

    // 系统分钟统计
    pipeline.hincrby(systemMinuteKey, 'requests', 1)
    pipeline.hincrby(systemMinuteKey, 'totalTokens', totalTokens)
    pipeline.hincrby(systemMinuteKey, 'inputTokens', finalInputTokens)
    pipeline.hincrby(systemMinuteKey, 'outputTokens', finalOutputTokens)

    // 设置过期时间
    pipeline.expire(daily, 86400 * 32)
    pipeline.expire(monthly, 86400 * 365)
    pipeline.expire(hourly, 86400 * 7)

    const configLocal = require('../../config/config')
    const { metricsWindow } = configLocal.system
    pipeline.expire(systemMinuteKey, metricsWindow * 60 * 2)

    await pipeline.exec()
  }

  async incrementAccountUsage(
    accountId,
    totalTokens,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    isLongContextRequest = false
  ) {
    const now = new Date()
    const today = getDateStringInTimezone(now)
    const tzDate = getDateInTimezone(now)
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const currentHour = `${today}:${String(getHourInTimezone(now)).padStart(2, '0')}`

    const accountKey = `account_usage:${accountId}`
    const accountDaily = `account_usage:daily:${accountId}:${today}`
    const accountMonthly = `account_usage:monthly:${accountId}:${currentMonth}`
    const accountHourly = `account_usage:hourly:${accountId}:${currentHour}`

    const normalizedModel = this._normalizeModelName(model)

    const finalInputTokens = inputTokens || 0
    const finalOutputTokens = outputTokens || 0
    const finalCacheCreateTokens = cacheCreateTokens || 0
    const finalCacheReadTokens = cacheReadTokens || 0
    const actualTotalTokens =
      finalInputTokens + finalOutputTokens + finalCacheCreateTokens + finalCacheReadTokens
    const coreTokens = finalInputTokens + finalOutputTokens

    const operations = [
      this.hincrby(accountKey, 'totalTokens', coreTokens),
      this.hincrby(accountKey, 'totalInputTokens', finalInputTokens),
      this.hincrby(accountKey, 'totalOutputTokens', finalOutputTokens),
      this.hincrby(accountKey, 'totalAllTokens', actualTotalTokens),
      this.hincrby(accountKey, 'totalRequests', 1),

      this.hincrby(accountDaily, 'tokens', coreTokens),
      this.hincrby(accountDaily, 'inputTokens', finalInputTokens),
      this.hincrby(accountDaily, 'outputTokens', finalOutputTokens),
      this.hincrby(accountDaily, 'allTokens', actualTotalTokens),
      this.hincrby(accountDaily, 'requests', 1),

      this.hincrby(accountHourly, 'inputTokens', finalInputTokens),
      this.hincrby(accountHourly, 'outputTokens', finalOutputTokens),
      this.hincrby(accountHourly, 'allTokens', actualTotalTokens),
      this.hincrby(accountHourly, 'requests', 1),

      // 模型级别统计
      this.hincrby(accountHourly, `model:${normalizedModel}:inputTokens`, finalInputTokens),
      this.hincrby(accountHourly, `model:${normalizedModel}:outputTokens`, finalOutputTokens),
      this.hincrby(accountHourly, `model:${normalizedModel}:allTokens`, actualTotalTokens),
      this.hincrby(accountHourly, `model:${normalizedModel}:requests`, 1),

      this.expire(accountDaily, 86400 * 32),
      this.expire(accountMonthly, 86400 * 365),
      this.expire(accountHourly, 86400 * 7)
    ]

    await Promise.all(operations)
  }

  async getUsageStats(keyId) {
    const totalKey = `usage:${keyId}`
    const today = getDateStringInTimezone()
    const dailyKey = `usage:daily:${keyId}:${today}`
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const monthlyKey = `usage:monthly:${keyId}:${currentMonth}`

    const [total, daily, monthly] = await Promise.all([
      this.hgetall(totalKey),
      this.hgetall(dailyKey),
      this.hgetall(monthlyKey)
    ])

    const keyData = await this.hgetall(`apikey:${keyId}`)
    const createdAt = keyData.createdAt ? new Date(keyData.createdAt) : new Date()
    const now = new Date()
    const daysSinceCreated = Math.max(1, Math.ceil((now - createdAt) / (1000 * 60 * 60 * 24)))

    const totalTokens = parseInt(total.totalTokens) || 0
    const totalRequests = parseInt(total.totalRequests) || 0

    const totalMinutes = Math.max(1, daysSinceCreated * 24 * 60)
    const avgRPM = totalRequests / totalMinutes
    const avgTPM = totalTokens / totalMinutes

    const handleLegacyData = (data) => {
      const tokens = parseInt(data.totalTokens) || parseInt(data.tokens) || 0
      const inputTokens = parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
      const outputTokens = parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
      const requests = parseInt(data.totalRequests) || parseInt(data.requests) || 0
      const cacheCreateTokens =
        parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
      const cacheReadTokens =
        parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
      const allTokens = parseInt(data.totalAllTokens) || parseInt(data.allTokens) || 0

      const actualAllTokens =
        allTokens || inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      return {
        tokens: actualAllTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        allTokens: actualAllTokens,
        requests
      }
    }

    return {
      total: handleLegacyData(total),
      daily: handleLegacyData(daily),
      monthly: handleLegacyData(monthly),
      averages: {
        rpm: Math.round(avgRPM * 100) / 100,
        tpm: Math.round(avgTPM * 100) / 100,
        dailyRequests: Math.round((totalRequests / daysSinceCreated) * 100) / 100,
        dailyTokens: Math.round((totalTokens / daysSinceCreated) * 100) / 100
      }
    }
  }

  async addUsageRecord(keyId, record, maxRecords = 200) {
    const listKey = `usage:records:${keyId}`
    try {
      await this.lpush(listKey, JSON.stringify(record))
      await this.ltrim(listKey, 0, Math.max(0, maxRecords - 1))
      await this.expire(listKey, 86400 * 90)
    } catch (error) {
      logger.error(`❌ Failed to append usage record for key ${keyId}:`, error)
    }
  }

  async getUsageRecords(keyId, limit = 50) {
    const listKey = `usage:records:${keyId}`
    try {
      const rawRecords = await this.lrange(listKey, 0, Math.max(0, limit - 1))
      return rawRecords
        .map((entry) => {
          try {
            return JSON.parse(entry)
          } catch (error) {
            return null
          }
        })
        .filter(Boolean)
    } catch (error) {
      logger.error(`❌ Failed to load usage records for key ${keyId}:`, error)
      return []
    }
  }

  // ==================== 费用相关操作 ====================

  async getDailyCost(keyId) {
    const today = getDateStringInTimezone()
    const costKey = `usage:cost:daily:${keyId}:${today}`
    const cost = await this.get(costKey)
    return parseFloat(cost || 0)
  }

  async incrementDailyCost(keyId, amount) {
    const today = getDateStringInTimezone()
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const currentHour = `${today}:${String(getHourInTimezone(new Date())).padStart(2, '0')}`

    const dailyKey = `usage:cost:daily:${keyId}:${today}`
    const monthlyKey = `usage:cost:monthly:${keyId}:${currentMonth}`
    const hourlyKey = `usage:cost:hourly:${keyId}:${currentHour}`
    const totalKey = `usage:cost:total:${keyId}`

    await Promise.all([
      this.incrbyfloat(dailyKey, amount),
      this.incrbyfloat(monthlyKey, amount),
      this.incrbyfloat(hourlyKey, amount),
      this.incrbyfloat(totalKey, amount),
      this.expire(dailyKey, 86400 * 30),
      this.expire(monthlyKey, 86400 * 90),
      this.expire(hourlyKey, 86400 * 7)
    ])
  }

  async getCostStats(keyId) {
    const today = getDateStringInTimezone()
    const tzDate = getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
    const currentHour = `${today}:${String(getHourInTimezone(new Date())).padStart(2, '0')}`

    const [daily, monthly, hourly, total] = await Promise.all([
      this.get(`usage:cost:daily:${keyId}:${today}`),
      this.get(`usage:cost:monthly:${keyId}:${currentMonth}`),
      this.get(`usage:cost:hourly:${keyId}:${currentHour}`),
      this.get(`usage:cost:total:${keyId}`)
    ])

    return {
      daily: parseFloat(daily || 0),
      monthly: parseFloat(monthly || 0),
      hourly: parseFloat(hourly || 0),
      total: parseFloat(total || 0)
    }
  }

  async getWeeklyOpusCost(keyId) {
    const currentWeek = getWeekStringInTimezone()
    const costKey = `usage:opus:weekly:${keyId}:${currentWeek}`
    const cost = await this.get(costKey)
    return parseFloat(cost || 0)
  }

  async incrementWeeklyOpusCost(keyId, amount) {
    const currentWeek = getWeekStringInTimezone()
    const weeklyKey = `usage:opus:weekly:${keyId}:${currentWeek}`
    const totalKey = `usage:opus:total:${keyId}`

    const pipeline = this.pipeline()
    pipeline.incrbyfloat(weeklyKey, amount)
    pipeline.incrbyfloat(totalKey, amount)
    pipeline.expire(weeklyKey, 14 * 24 * 3600)
    await pipeline.exec()
  }

  async getAccountDailyCost(accountId) {
    // 简化实现，返回 0
    return 0
  }

  // ==================== 账户管理相关操作 ====================

  async getAccountUsageStats(accountId, accountType = null) {
    const accountKey = `account_usage:${accountId}`
    const today = getDateStringInTimezone()
    const accountDailyKey = `account_usage:daily:${accountId}:${today}`

    const [total, daily] = await Promise.all([
      this.hgetall(accountKey),
      this.hgetall(accountDailyKey)
    ])

    const handleAccountData = (data) => {
      return {
        tokens: parseInt(data.totalTokens) || 0,
        inputTokens: parseInt(data.totalInputTokens) || 0,
        outputTokens: parseInt(data.totalOutputTokens) || 0,
        allTokens: parseInt(data.totalAllTokens) || 0,
        requests: parseInt(data.totalRequests) || 0
      }
    }

    return {
      accountId,
      total: handleAccountData(total),
      daily: {
        ...handleAccountData(daily),
        cost: 0
      },
      monthly: handleAccountData({}),
      averages: {
        rpm: 0,
        tpm: 0,
        dailyRequests: 0,
        dailyTokens: 0
      }
    }
  }

  async getAllAccountsUsageStats() {
    return []
  }

  async resetAllUsageStats() {
    const stats = {
      deletedKeys: 0,
      deletedDailyKeys: 0,
      deletedMonthlyKeys: 0,
      resetApiKeys: 0
    }

    const apiKeyKeys = await this.keys('apikey:*')
    for (const key of apiKeyKeys) {
      if (key === 'apikey:hash_map') continue
      const keyId = key.replace('apikey:', '')

      await this.del(`usage:${keyId}`)
      const dailyKeys = await this.keys(`usage:daily:${keyId}:*`)
      if (dailyKeys.length > 0) {
        await this.del(...dailyKeys)
      }

      stats.deletedKeys++
    }

    return stats
  }

  async setClaudeAccount(accountId, accountData) {
    const key = `claude:account:${accountId}`
    await this.hset(key, accountData)
  }

  async getClaudeAccount(accountId) {
    const key = `claude:account:${accountId}`
    return await this.hgetall(key)
  }

  async getAllClaudeAccounts() {
    const keys = await this.keys('claude:account:*')
    const accounts = []
    for (const key of keys) {
      const accountData = await this.hgetall(key)
      if (accountData && Object.keys(accountData).length > 0) {
        accounts.push({ id: key.replace('claude:account:', ''), ...accountData })
      }
    }
    return accounts
  }

  async deleteClaudeAccount(accountId) {
    const key = `claude:account:${accountId}`
    return await this.del(key)
  }

  async setDroidAccount(accountId, accountData) {
    const key = `droid:account:${accountId}`
    await this.hset(key, accountData)
  }

  async getDroidAccount(accountId) {
    const key = `droid:account:${accountId}`
    return await this.hgetall(key)
  }

  async getAllDroidAccounts() {
    const keys = await this.keys('droid:account:*')
    const accounts = []
    for (const key of keys) {
      const accountData = await this.hgetall(key)
      if (accountData && Object.keys(accountData).length > 0) {
        accounts.push({ id: key.replace('droid:account:', ''), ...accountData })
      }
    }
    return accounts
  }

  async deleteDroidAccount(accountId) {
    const key = `droid:account:${accountId}`
    return await this.del(key)
  }

  async setOpenAiAccount(accountId, accountData) {
    const key = `openai:account:${accountId}`
    await this.hset(key, accountData)
  }

  async getOpenAiAccount(accountId) {
    const key = `openai:account:${accountId}`
    return await this.hgetall(key)
  }

  async deleteOpenAiAccount(accountId) {
    const key = `openai:account:${accountId}`
    return await this.del(key)
  }

  async getAllOpenAIAccounts() {
    const keys = await this.keys('openai:account:*')
    const accounts = []
    for (const key of keys) {
      const accountData = await this.hgetall(key)
      if (accountData && Object.keys(accountData).length > 0) {
        accounts.push({ id: key.replace('openai:account:', ''), ...accountData })
      }
    }
    return accounts
  }

  // ==================== 会话管理 ====================

  async setSession(sessionId, sessionData, ttl = 86400) {
    const key = `session:${sessionId}`
    await this.hset(key, sessionData)
    await this.expire(key, ttl)
  }

  async getSession(sessionId) {
    const key = `session:${sessionId}`
    return await this.hgetall(key)
  }

  async deleteSession(sessionId) {
    const key = `session:${sessionId}`
    return await this.del(key)
  }

  async setApiKeyHash(hashedKey, keyData, ttl = 0) {
    const key = `apikey_hash:${hashedKey}`
    await this.hset(key, keyData)
    if (ttl > 0) {
      await this.expire(key, ttl)
    }
  }

  async getApiKeyHash(hashedKey) {
    const key = `apikey_hash:${hashedKey}`
    return await this.hgetall(key)
  }

  async deleteApiKeyHash(hashedKey) {
    const key = `apikey_hash:${hashedKey}`
    return await this.del(key)
  }

  async setOAuthSession(sessionId, sessionData, ttl = 600) {
    const key = `oauth:${sessionId}`
    const serializedData = {}
    for (const [dataKey, value] of Object.entries(sessionData)) {
      if (typeof value === 'object' && value !== null) {
        serializedData[dataKey] = JSON.stringify(value)
      } else {
        serializedData[dataKey] = value
      }
    }
    await this.hset(key, serializedData)
    await this.expire(key, ttl)
  }

  async getOAuthSession(sessionId) {
    const key = `oauth:${sessionId}`
    const data = await this.hgetall(key)
    if (data.proxy) {
      try {
        data.proxy = JSON.parse(data.proxy)
      } catch (error) {
        data.proxy = null
      }
    }
    return data
  }

  async deleteOAuthSession(sessionId) {
    const key = `oauth:${sessionId}`
    return await this.del(key)
  }

  // ==================== 系统统计 ====================

  async getSystemStats() {
    const keys = await Promise.all([
      this.keys('apikey:*'),
      this.keys('claude:account:*'),
      this.keys('usage:*')
    ])

    return {
      totalApiKeys: keys[0].length,
      totalClaudeAccounts: keys[1].length,
      totalUsageRecords: keys[2].length
    }
  }

  async getTodayStats() {
    try {
      const today = getDateStringInTimezone()
      const dailyKeys = await this.keys(`usage:daily:*:${today}`)

      let totalRequestsToday = 0
      let totalTokensToday = 0
      let totalInputTokensToday = 0
      let totalOutputTokensToday = 0

      for (const key of dailyKeys) {
        const dailyData = await this.hgetall(key)
        totalRequestsToday += parseInt(dailyData.requests) || 0
        totalTokensToday += parseInt(dailyData.tokens) || 0
        totalInputTokensToday += parseInt(dailyData.inputTokens) || 0
        totalOutputTokensToday += parseInt(dailyData.outputTokens) || 0
      }

      return {
        requestsToday: totalRequestsToday,
        tokensToday: totalTokensToday,
        inputTokensToday: totalInputTokensToday,
        outputTokensToday: totalOutputTokensToday,
        cacheCreateTokensToday: 0,
        cacheReadTokensToday: 0,
        apiKeysCreatedToday: 0
      }
    } catch (error) {
      return {
        requestsToday: 0,
        tokensToday: 0,
        inputTokensToday: 0,
        outputTokensToday: 0,
        cacheCreateTokensToday: 0,
        cacheReadTokensToday: 0,
        apiKeysCreatedToday: 0
      }
    }
  }

  async getSystemAverages() {
    return {
      systemRPM: 0,
      systemTPM: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0
    }
  }

  async getRealtimeSystemMetrics() {
    try {
      const configLocal = require('../../config/config')
      const windowMinutes = configLocal.system.metricsWindow || 5

      const now = new Date()
      const currentMinute = Math.floor(now.getTime() / 60000)

      let totalRequests = 0
      let totalTokens = 0
      let totalInputTokens = 0
      let totalOutputTokens = 0

      for (let i = 0; i < windowMinutes; i++) {
        const minuteKey = `system:metrics:minute:${currentMinute - i}`
        const data = await this.hgetall(minuteKey)

        if (data && Object.keys(data).length > 0) {
          totalRequests += parseInt(data.requests || 0)
          totalTokens += parseInt(data.totalTokens || 0)
          totalInputTokens += parseInt(data.inputTokens || 0)
          totalOutputTokens += parseInt(data.outputTokens || 0)
        }
      }

      const realtimeRPM =
        windowMinutes > 0 ? Math.round((totalRequests / windowMinutes) * 100) / 100 : 0
      const realtimeTPM =
        windowMinutes > 0 ? Math.round((totalTokens / windowMinutes) * 100) / 100 : 0

      return {
        realtimeRPM,
        realtimeTPM,
        windowMinutes,
        totalRequests,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreateTokens: 0,
        totalCacheReadTokens: 0
      }
    } catch (error) {
      return {
        realtimeRPM: 0,
        realtimeTPM: 0,
        windowMinutes: 0,
        totalRequests: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreateTokens: 0,
        totalCacheReadTokens: 0
      }
    }
  }

  // ==================== 粘性会话管理 ====================

  async setSessionAccountMapping(sessionHash, accountId, ttl = null) {
    const appConfig = require('../../config/config')
    const defaultTTL = ttl !== null ? ttl : (appConfig.session?.stickyTtlHours || 1) * 60 * 60
    const key = `sticky_session:${sessionHash}`
    await this.set(key, accountId, 'EX', defaultTTL)
  }

  async getSessionAccountMapping(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    return await this.get(key)
  }

  async extendSessionAccountMappingTTL(sessionHash) {
    const appConfig = require('../../config/config')
    const key = `sticky_session:${sessionHash}`
    const ttlHours = appConfig.session?.stickyTtlHours || 1
    const thresholdMinutes = appConfig.session?.renewalThresholdMinutes || 0

    if (thresholdMinutes === 0) {
      return true
    }

    const fullTTL = ttlHours * 60 * 60
    const renewalThreshold = thresholdMinutes * 60

    try {
      const remainingTTL = await this.ttl(key)

      if (remainingTTL === -2) {
        return false
      }

      if (remainingTTL === -1) {
        return true
      }

      if (remainingTTL < renewalThreshold) {
        await this.expire(key, fullTTL)
        return true
      }

      return true
    } catch (error) {
      logger.error('❌ Failed to extend session TTL:', error)
      return false
    }
  }

  async deleteSessionAccountMapping(sessionHash) {
    const key = `sticky_session:${sessionHash}`
    return await this.del(key)
  }

  // ==================== 清理任务 ====================

  async cleanup() {
    try {
      logger.info('🧹 Memory cleanup completed (automatic)')
    } catch (error) {
      logger.error('❌ Cleanup failed:', error)
    }
  }

  // ==================== 并发控制 ====================

  _getConcurrencyConfig() {
    const defaults = {
      leaseSeconds: 300,
      renewIntervalSeconds: 30,
      cleanupGraceSeconds: 30
    }

    return {
      ...defaults,
      ...(config.concurrency || {})
    }
  }

  async incrConcurrency(apiKeyId, requestId, leaseSeconds = null) {
    if (!requestId) {
      throw new Error('Request ID is required for concurrency tracking')
    }

    try {
      const { leaseSeconds: defaultLeaseSeconds, cleanupGraceSeconds } =
        this._getConcurrencyConfig()
      const lease = leaseSeconds || defaultLeaseSeconds
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()
      const expireAt = now + lease * 1000
      const ttl = Math.max((lease + cleanupGraceSeconds) * 1000, 60000)

      // 清理过期项
      await this.zremrangebyscore(key, '-inf', now)
      // 添加新项
      await this.zadd(key, expireAt, requestId)
      // 设置键过期
      if (ttl > 0) {
        this.ttls.set(key, Date.now() + ttl)
      }

      const count = await this.zcard(key)
      logger.database(
        `🔢 Incremented concurrency for key ${apiKeyId}: ${count} (request ${requestId})`
      )
      return count
    } catch (error) {
      logger.error('❌ Failed to increment concurrency:', error)
      throw error
    }
  }

  async refreshConcurrencyLease(apiKeyId, requestId, leaseSeconds = null) {
    if (!requestId) {
      return 0
    }

    try {
      const { leaseSeconds: defaultLeaseSeconds, cleanupGraceSeconds } =
        this._getConcurrencyConfig()
      const lease = leaseSeconds || defaultLeaseSeconds
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()
      const expireAt = now + lease * 1000
      const ttl = Math.max((lease + cleanupGraceSeconds) * 1000, 60000)

      await this.zremrangebyscore(key, '-inf', now)
      const exists = await this.zscore(key, requestId)

      if (exists !== null) {
        await this.zadd(key, expireAt, requestId)
        if (ttl > 0) {
          this.ttls.set(key, Date.now() + ttl)
        }
        return 1
      }

      return 0
    } catch (error) {
      logger.error('❌ Failed to refresh concurrency lease:', error)
      return 0
    }
  }

  async decrConcurrency(apiKeyId, requestId) {
    try {
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()

      if (requestId) {
        await this.zrem(key, requestId)
      }

      await this.zremrangebyscore(key, '-inf', now)

      const count = await this.zcard(key)
      if (count <= 0) {
        await this.del(key)
        return 0
      }

      logger.database(
        `🔢 Decremented concurrency for key ${apiKeyId}: ${count} (request ${requestId || 'n/a'})`
      )
      return count
    } catch (error) {
      logger.error('❌ Failed to decrement concurrency:', error)
      throw error
    }
  }

  async getConcurrency(apiKeyId) {
    try {
      const key = `concurrency:${apiKeyId}`
      const now = Date.now()

      await this.zremrangebyscore(key, '-inf', now)
      return await this.zcard(key)
    } catch (error) {
      logger.error('❌ Failed to get concurrency:', error)
      return 0
    }
  }

  async incrConsoleAccountConcurrency(accountId, requestId, leaseSeconds = null) {
    if (!requestId) {
      throw new Error('Request ID is required for console account concurrency tracking')
    }
    const compositeKey = `console_account:${accountId}`
    return await this.incrConcurrency(compositeKey, requestId, leaseSeconds)
  }

  async refreshConsoleAccountConcurrencyLease(accountId, requestId, leaseSeconds = null) {
    if (!requestId) {
      return 0
    }
    const compositeKey = `console_account:${accountId}`
    return await this.refreshConcurrencyLease(compositeKey, requestId, leaseSeconds)
  }

  async decrConsoleAccountConcurrency(accountId, requestId) {
    const compositeKey = `console_account:${accountId}`
    return await this.decrConcurrency(compositeKey, requestId)
  }

  async getConsoleAccountConcurrency(accountId) {
    const compositeKey = `console_account:${accountId}`
    return await this.getConcurrency(compositeKey)
  }

  // ==================== 会话窗口使用统计 ====================

  async getAccountSessionWindowUsage(accountId, windowStart, windowEnd) {
    try {
      if (!windowStart || !windowEnd) {
        return {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreateTokens: 0,
          totalCacheReadTokens: 0,
          totalAllTokens: 0,
          totalRequests: 0,
          modelUsage: {}
        }
      }

      const startDate = new Date(windowStart)
      const endDate = new Date(windowEnd)

      const hourlyKeys = []
      const currentHour = new Date(startDate)
      currentHour.setMinutes(0)
      currentHour.setSeconds(0)
      currentHour.setMilliseconds(0)

      while (currentHour <= endDate) {
        const tzDateStr = getDateStringInTimezone(currentHour)
        const tzHour = String(getHourInTimezone(currentHour)).padStart(2, '0')
        const key = `account_usage:hourly:${accountId}:${tzDateStr}:${tzHour}`
        hourlyKeys.push(key)
        currentHour.setHours(currentHour.getHours() + 1)
      }

      let totalInputTokens = 0
      let totalOutputTokens = 0
      let totalCacheCreateTokens = 0
      let totalCacheReadTokens = 0
      let totalAllTokens = 0
      let totalRequests = 0
      const modelUsage = {}

      for (const key of hourlyKeys) {
        const data = await this.hgetall(key)

        if (!data || Object.keys(data).length === 0) {
          continue
        }

        totalInputTokens += parseInt(data.inputTokens || 0)
        totalOutputTokens += parseInt(data.outputTokens || 0)
        totalCacheCreateTokens += parseInt(data.cacheCreateTokens || 0)
        totalCacheReadTokens += parseInt(data.cacheReadTokens || 0)
        totalAllTokens += parseInt(data.allTokens || 0)
        totalRequests += parseInt(data.requests || 0)

        // 处理模型数据
        for (const [dataKey, value] of Object.entries(data)) {
          if (dataKey.startsWith('model:')) {
            const parts = dataKey.split(':')
            if (parts.length >= 3) {
              const modelName = parts[1]
              const metric = parts.slice(2).join(':')

              if (!modelUsage[modelName]) {
                modelUsage[modelName] = {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheCreateTokens: 0,
                  cacheReadTokens: 0,
                  allTokens: 0,
                  requests: 0
                }
              }

              if (metric === 'inputTokens') {
                modelUsage[modelName].inputTokens += parseInt(value || 0)
              } else if (metric === 'outputTokens') {
                modelUsage[modelName].outputTokens += parseInt(value || 0)
              } else if (metric === 'allTokens') {
                modelUsage[modelName].allTokens += parseInt(value || 0)
              } else if (metric === 'requests') {
                modelUsage[modelName].requests += parseInt(value || 0)
              }
            }
          }
        }
      }

      return {
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreateTokens,
        totalCacheReadTokens,
        totalAllTokens,
        totalRequests,
        modelUsage
      }
    } catch (error) {
      logger.error(`❌ Failed to get session window usage for account ${accountId}:`, error)
      return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreateTokens: 0,
        totalCacheReadTokens: 0,
        totalAllTokens: 0,
        totalRequests: 0,
        modelUsage: {}
      }
    }
  }
}

const memoryRedisClient = new MemoryRedisClient()

// 分布式锁方法
memoryRedisClient.setAccountLock = async function (lockKey, lockValue, ttlMs) {
  try {
    const result = await this.set(lockKey, lockValue, 'PX', ttlMs, 'NX')
    return result === 'OK'
  } catch (error) {
    logger.error(`Failed to acquire lock ${lockKey}:`, error)
    return false
  }
}

memoryRedisClient.releaseAccountLock = async function (lockKey, lockValue) {
  try {
    const current = await this.get(lockKey)
    if (current === lockValue) {
      await this.del(lockKey)
      return true
    }
    return false
  } catch (error) {
    logger.error(`Failed to release lock ${lockKey}:`, error)
    return false
  }
}

// 导出时区辅助函数
memoryRedisClient.getDateInTimezone = getDateInTimezone
memoryRedisClient.getDateStringInTimezone = getDateStringInTimezone
memoryRedisClient.getHourInTimezone = getHourInTimezone
memoryRedisClient.getWeekStringInTimezone = getWeekStringInTimezone

module.exports = memoryRedisClient
