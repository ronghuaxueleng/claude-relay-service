#!/usr/bin/env node

/**
 * Claude Relay Service - ESM 启动脚本
 *
 * 功能特性:
 * - ESM 格式 (import/export)
 * - 跨平台支持 (Windows/Linux/macOS)
 * - 环境变量自动加载
 * - 可选的 lint 检查
 * - 优雅的错误处理和退出
 * - 彩色输出和进度提示
 *
 * 使用方法:
 *   node start.mjs              # 直接启动
 *   node start.mjs --skip-lint  # 跳过 lint 检查
 *   node start.mjs --help       # 显示帮助信息
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { platform } from 'os'
import { randomBytes } from 'crypto'

// 获取当前文件路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 创建 require 函数用于加载 CommonJS 模块
const require = createRequire(import.meta.url)

// 检测操作系统
const isWindows = platform() === 'win32'
const platformName = isWindows ? 'Windows' : platform()

// 启用 Windows 控制台颜色支持（Windows 10+）
if (isWindows && process.stdout.isTTY) {
  // 强制启用颜色支持
  process.env.FORCE_COLOR = '1'
}

// 颜色输出工具（跨平台兼容）
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg) => console.warn(`${colors.yellow}⚠${colors.reset} ${msg}`),
  step: (msg) => console.log(`${colors.cyan}▸${colors.reset} ${msg}`)
}

// 解析命令行参数
const args = process.argv.slice(2)
const options = {
  // 默认跳过 lint，只有明确指定 --lint 时才运行
  skipLint: !args.includes('--lint'),
  help: args.includes('--help') || args.includes('-h')
}

// 显示帮助信息
if (options.help) {
  // Windows 兼容的边框字符
  const borderChar = isWindows ? '=' : '═'
  const cornerTL = isWindows ? '+' : '╔'
  const cornerTR = isWindows ? '+' : '╗'
  const cornerBL = isWindows ? '+' : '╚'
  const cornerBR = isWindows ? '+' : '╝'
  const vertical = isWindows ? '|' : '║'

  console.log(`
${colors.bright}${colors.cyan}${cornerTL}${borderChar.repeat(48)}${cornerTR}
${vertical}  Claude Relay Service - ESM 启动脚本          ${vertical}
${vertical}  Platform: ${platformName.padEnd(36)} ${vertical}
${cornerBL}${borderChar.repeat(48)}${cornerBR}${colors.reset}

${colors.bright}使用方法:${colors.reset}
  node start.mjs              直接启动服务（默认跳过 lint）
  node start.mjs --lint       启动前运行代码检查
  node start.mjs --help       显示此帮助信息

${colors.bright}选项:${colors.reset}
  --lint            启用 ESLint 代码检查
  --help, -h        显示帮助信息

${colors.bright}环境变量:${colors.reset}
  NODE_ENV          运行环境 (development/production)
  PORT              服务端口 (默认: 3000)
  REDIS_HOST        Redis 主机地址
  REDIS_PORT        Redis 端口

${colors.bright}示例:${colors.reset}
  ${colors.cyan}# 开发环境启动${colors.reset}
  ${isWindows ? 'set NODE_ENV=development && node start.mjs' : 'NODE_ENV=development node start.mjs'}

  ${colors.cyan}# 生产环境启动${colors.reset}
  ${isWindows ? 'set NODE_ENV=production && node start.mjs' : 'NODE_ENV=production node start.mjs'}

  ${colors.cyan}# 启动前运行代码检查${colors.reset}
  node start.mjs --lint

  ${colors.cyan}# 使用 PM2 启动${colors.reset}
  pm2 start start.mjs --name claude-relay-service

  ${colors.cyan}# Windows 下复制配置文件${colors.reset}
  ${isWindows ? 'copy .env.example .env' : 'cp .env.example .env'}
  ${isWindows ? 'copy config\\config.example.js config\\config.js' : 'cp config/config.example.js config/config.js'}
`)
  process.exit(0)
}

// 执行 shell 命令的辅助函数（跨平台兼容）
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    // Windows 下需要特殊处理 npm 命令
    let finalCommand = command
    let finalArgs = args

    if (isWindows) {
      if (command === 'npm') {
        // Windows 下使用 npm.cmd
        finalCommand = 'npm.cmd'
      } else if (command === 'node') {
        // Windows 下使用 node.exe
        finalCommand = 'node.exe'
      }
    }

    const spawnOptions = {
      stdio: 'inherit',
      shell: isWindows, // Windows 下必须使用 shell
      windowsHide: true, // Windows 下隐藏子进程窗口
      env: { ...process.env }, // 继承环境变量
      ...options
    }

    const child = spawn(finalCommand, finalArgs, spawnOptions)

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`命令执行失败，退出码: ${code}`))
      }
    })

    child.on('error', (error) => {
      reject(error)
    })
  })
}

// 检查环境配置
async function checkEnvironment() {
  log.step('检查环境配置...')

  // 检查关键依赖是否存在
  const nodeModulesPath = join(__dirname, 'node_modules')
  const keyDependencies = [
    join(__dirname, 'node_modules', 'dotenv'),
    join(__dirname, 'node_modules', 'express'),
    join(__dirname, 'node_modules', 'eslint')
  ]

  const needsInstall =
    !existsSync(nodeModulesPath) || keyDependencies.some((dep) => !existsSync(dep))

  if (needsInstall) {
    if (!existsSync(nodeModulesPath)) {
      log.warn('node_modules 目录不存在，依赖未安装')
    } else {
      log.warn('检测到关键依赖缺失（dotenv/express/eslint）')
    }
    log.info('正在自动安装依赖...')
    console.log() // 空行分隔

    try {
      await runCommand('npm', ['install'])
      console.log() // 空行分隔
      log.success('依赖安装完成')
    } catch (error) {
      log.error('依赖安装失败')
      log.info('请手动运行: npm install')
      process.exit(1)
    }
  } else {
    log.success('依赖已安装')
  }

  // 检查并自动创建 .env 文件
  const envPath = join(__dirname, '.env')
  const envExamplePath = join(__dirname, '.env.example')

  if (!existsSync(envPath)) {
    log.warn('.env 文件不存在')

    // 检查示例文件是否存在
    if (existsSync(envExamplePath)) {
      try {
        copyFileSync(envExamplePath, envPath)
        log.success('已自动创建 .env 文件（从 .env.example 复制）')
        log.info('请根据需要修改 .env 中的配置')
      } catch (error) {
        log.error(`创建 .env 文件失败: ${error.message}`)
        const copyCmd = isWindows ? 'copy .env.example .env' : 'cp .env.example .env'
        log.info(`请手动运行: ${copyCmd}`)
        process.exit(1)
      }
    } else {
      log.error('.env.example 文件不存在，无法自动创建')
      process.exit(1)
    }
  } else {
    log.success('.env 文件存在')
  }

  // 检查并自动创建配置文件
  const configPath = join(__dirname, 'config', 'config.js')
  const configExamplePath = join(__dirname, 'config', 'config.example.js')
  const configDir = join(__dirname, 'config')

  if (!existsSync(configPath)) {
    log.warn('config/config.js 配置文件不存在')

    // 确保 config 目录存在
    if (!existsSync(configDir)) {
      try {
        mkdirSync(configDir, { recursive: true })
        log.info('已创建 config 目录')
      } catch (error) {
        log.error(`创建 config 目录失败: ${error.message}`)
        process.exit(1)
      }
    }

    // 检查示例文件是否存在
    if (existsSync(configExamplePath)) {
      try {
        copyFileSync(configExamplePath, configPath)
        log.success('已自动创建 config/config.js 文件（从 config.example.js 复制）')
        log.info('请根据需要修改 config/config.js 中的配置')
      } catch (error) {
        log.error(`创建配置文件失败: ${error.message}`)
        const copyCmd = isWindows
          ? 'copy config\\config.example.js config\\config.js'
          : 'cp config/config.example.js config/config.js'
        log.info(`请手动运行: ${copyCmd}`)
        process.exit(1)
      }
    } else {
      log.error('config/config.example.js 文件不存在，无法自动创建')
      process.exit(1)
    }
  } else {
    log.success('配置文件存在')
  }

  // 检查并生成管理员凭据
  const dataDir = join(__dirname, 'data')
  const initPath = join(dataDir, 'init.json')

  if (!existsSync(initPath)) {
    log.warn('管理员凭据未初始化')

    // 确保 data 目录存在
    if (!existsSync(dataDir)) {
      try {
        mkdirSync(dataDir, { recursive: true })
        log.info('已创建 data 目录')
      } catch (error) {
        log.error(`创建 data 目录失败: ${error.message}`)
        process.exit(1)
      }
    }

    // 尝试加载 dotenv 以读取环境变量
    try {
      const dotenv = require('dotenv')
      dotenv.config()
    } catch (error) {
      log.warn('无法加载 dotenv 模块，将使用随机凭据')
    }

    // 从环境变量读取或生成随机凭据
    const adminUsername = process.env.ADMIN_USERNAME || `cr_admin_${randomBytes(4).toString('hex')}`
    const adminPassword =
      process.env.ADMIN_PASSWORD ||
      randomBytes(16)
        .toString('base64')
        .replace(/[^a-zA-Z0-9]/g, '')
        .substring(0, 16)

    // 生成 init.json 文件
    const initData = {
      initializedAt: new Date().toISOString(),
      adminUsername,
      adminPassword,
      version: '1.0.0'
    }

    try {
      writeFileSync(initPath, JSON.stringify(initData, null, 2))
      log.success('已自动生成管理员凭据文件')

      if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
        log.info(`使用 .env 中配置的管理员凭据`)
        log.info(`管理员用户名: ${adminUsername}`)
      } else {
        log.warn('使用随机生成的管理员凭据:')
        log.info(`管理员用户名: ${adminUsername}`)
        log.info(`管理员密码: ${adminPassword}`)
        log.warn('⚠️  请立即保存这些凭据！')
      }
    } catch (error) {
      log.error(`创建管理员凭据文件失败: ${error.message}`)
      log.info('请手动运行: npm run setup')
      process.exit(1)
    }
  } else {
    log.success('管理员凭据已初始化')
  }

  // 检查前端构建
  const adminSpaDistPath = join(__dirname, 'web', 'admin-spa', 'dist')
  const adminSpaPath = join(__dirname, 'web', 'admin-spa')

  if (!existsSync(adminSpaDistPath)) {
    log.warn('前端项目未构建（web/admin-spa/dist 不存在）')

    // 检查前端项目是否存在
    if (existsSync(adminSpaPath)) {
      // 检查前端依赖
      const webNodeModules = join(adminSpaPath, 'node_modules')
      const needsWebInstall = !existsSync(webNodeModules)

      if (needsWebInstall) {
        log.info('正在安装前端依赖...')
        console.log() // 空行分隔

        try {
          await runCommand('npm', ['install'], { cwd: adminSpaPath })
          console.log() // 空行分隔
          log.success('前端依赖安装完成')
        } catch (error) {
          log.error('前端依赖安装失败')
          log.info('请手动运行: cd web/admin-spa && npm install')
          process.exit(1)
        }
      }

      // 构建前端项目
      log.info('正在构建前端项目...')
      console.log() // 空行分隔

      try {
        await runCommand('npm', ['run', 'build'], { cwd: adminSpaPath })
        console.log() // 空行分隔
        log.success('前端项目构建完成')
      } catch (error) {
        log.error('前端项目构建失败')
        log.info('请手动运行: cd web/admin-spa && npm run build')
        log.warn('服务仍可启动，但 Web 管理界面将不可用')
      }
    } else {
      log.warn('前端项目目录不存在，跳过构建')
    }
  } else {
    log.success('前端项目已构建')
  }

  log.success('环境配置检查完成')
}

// 运行 lint 检查
async function runLint() {
  if (options.skipLint) {
    log.info('跳过代码检查（使用 --lint 参数可启用）')
    return
  }

  log.step('运行 ESLint 代码检查...')

  try {
    await runCommand('npm', ['run', 'lint'])
    log.success('代码检查通过')
  } catch (error) {
    log.error('代码检查失败')
    log.warn('提示: 默认已跳过 lint 检查，服务仍可正常启动')
    log.info('如需修复错误，请运行: npm run lint')
    throw error
  }
}

// 加载环境变量
function loadEnvironment() {
  log.step('加载环境变量...')

  try {
    // 使用 dotenv 加载环境变量
    const dotenv = require('dotenv')
    const result = dotenv.config()

    if (result.error) {
      log.warn('无法加载 .env 文件（这可能是正常的）')
    } else {
      log.success('环境变量加载完成')
    }
  } catch (error) {
    // 如果是模块未找到错误，给出更友好的提示
    if (error.code === 'MODULE_NOT_FOUND') {
      log.warn('dotenv 模块未安装，跳过环境变量加载')
      log.info('提示: 这不会影响启动，应用会使用默认配置')
    } else {
      log.warn(`环境变量加载出错: ${error.message}`)
    }
  }

  // 自动设置 GitHub 镜像代理（如果未配置）
  if (!process.env.PRICE_MIRROR_BASE_URL) {
    process.env.PRICE_MIRROR_BASE_URL =
      'https://gh-proxy.com/https://raw.githubusercontent.com/Wei-Shaw/claude-relay-service/price-mirror'
    log.info('已自动配置 GitHub 镜像代理用于下载定价数据')
  }
}

// 启动应用
async function startApplication() {
  log.step('启动 Claude Relay Service...')
  console.log() // 空行分隔

  try {
    // 动态导入 CommonJS 模块
    const Application = require('./src/app.js')

    // 创建应用实例并启动
    const app = new Application()
    await app.start()
  } catch (error) {
    log.error('应用启动失败')
    console.error(error)
    process.exit(1)
  }
}

// 主函数
async function main() {
  // Windows 兼容的边框字符
  const borderChar = isWindows ? '=' : '═'
  const cornerTL = isWindows ? '+' : '╔'
  const cornerTR = isWindows ? '+' : '╗'
  const cornerBL = isWindows ? '+' : '╚'
  const cornerBR = isWindows ? '+' : '╝'
  const vertical = isWindows ? '|' : '║'

  console.log(`
${colors.bright}${colors.cyan}${cornerTL}${borderChar.repeat(48)}${cornerTR}
${vertical}  Claude Relay Service - ESM 启动器          ${vertical}
${vertical}  Platform: ${platformName.padEnd(36)} ${vertical}
${cornerBL}${borderChar.repeat(48)}${cornerBR}${colors.reset}
`)

  const startTime = Date.now()

  try {
    // 1. 检查环境
    await checkEnvironment()
    console.log()

    // 2. 加载环境变量
    loadEnvironment()
    console.log()

    // 3. 运行 lint（可选）
    await runLint()
    console.log()

    // 4. 启动应用
    await startApplication()

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    log.success(`应用启动完成 (耗时: ${duration}s)`)
  } catch (error) {
    log.error(`启动过程失败: ${error.message}`)
    process.exit(1)
  }
}

// 错误处理
process.on('uncaughtException', (error) => {
  log.error('未捕获的异常:')
  console.error(error)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  log.error('未处理的 Promise 拒绝:')
  console.error('Promise:', promise)
  console.error('原因:', reason)
  process.exit(1)
})

// 优雅退出处理
const shutdown = (signal) => {
  console.log() // 换行
  log.info(`收到 ${signal} 信号，正在关闭...`)
  process.exit(0)
}

// Windows 下 SIGINT/SIGTERM 支持有限，需要特殊处理
if (isWindows) {
  // Windows 下主要监听 SIGINT（Ctrl+C）
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Windows 下可能不支持 SIGTERM，但还是监听一下
  try {
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  } catch (error) {
    // 忽略错误
  }
} else {
  // Unix-like 系统完整支持
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// 启动
main().catch((error) => {
  log.error('主函数执行失败')
  console.error(error)
  process.exit(1)
})
