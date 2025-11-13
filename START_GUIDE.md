# ESM 启动脚本使用指南

## 📋 简介

`start.mjs` 是一个完全跨平台的 ESM 格式启动脚本，支持 Windows、Linux 和 macOS。

## 🌐 跨平台特性

### 自动平台检测

脚本会自动检测运行的操作系统，并做出相应适配：

- ✅ **Windows 10/11** - 完全支持，包括颜色输出
- ✅ **Linux** - 原生支持
- ✅ **macOS** - 原生支持

### Windows 特殊优化

在 Windows 系统下，脚本会自动：

1. 使用 `npm.cmd` 代替 `npm`
2. 启用控制台颜色支持（Windows 10+）
3. 使用 Windows 风格的路径分隔符（`\`）
4. 显示 Windows 兼容的边框字符
5. 提供 Windows 特定的命令示例

## 🚀 使用方法

### Windows

```cmd
# 直接启动
node start.mjs

# 跳过 lint 检查
node start.mjs --skip-lint

# 设置环境变量并启动
set NODE_ENV=production && node start.mjs

# 查看帮助
node start.mjs --help
```

### Linux / macOS

```bash
# 直接启动
node start.mjs

# 跳过 lint 检查
node start.mjs --skip-lint

# 设置环境变量并启动
NODE_ENV=production node start.mjs

# 查看帮助
node start.mjs --help
```

### 使用 npm 脚本（跨平台）

```bash
# 完整启动（包含 lint）
npm run start:esm

# 跳过 lint 检查
npm run start:esm:skip-lint
```

## 📦 命令行选项

| 选项          | 简写 | 说明                 |
| ------------- | ---- | -------------------- |
| `--skip-lint` | `-s` | 跳过 ESLint 代码检查 |
| `--help`      | `-h` | 显示帮助信息         |

## 🔧 环境配置

### 首次使用

#### Windows

```cmd
# 1. 复制配置文件
copy .env.example .env
copy config\config.example.js config\config.js

# 2. 运行初始化脚本
npm run setup

# 3. 启动服务
node start.mjs
```

#### Linux / macOS

```bash
# 1. 复制配置文件
cp .env.example .env
cp config/config.example.js config/config.js

# 2. 运行初始化脚本
npm run setup

# 3. 启动服务
node start.mjs
```

## 🎯 启动流程

脚本会按以下顺序执行：

1. **检查环境配置** - 验证必需的配置文件
2. **加载环境变量** - 从 `.env` 文件加载
3. **代码检查**（可选）- 运行 ESLint
4. **启动应用** - 启动 Claude Relay Service

## 🎨 彩色输出

脚本支持彩色终端输出：

- 🔵 信息（蓝色）
- ✅ 成功（绿色）
- ⚠️ 警告（黄色）
- ❌ 错误（红色）
- ▸ 步骤提示（青色）

### Windows 颜色支持

- **Windows 10+**: 自动启用 ANSI 颜色支持
- **Windows 7/8**: 可能无颜色，但功能正常

## 🔄 使用 PM2 进程管理

### 基础使用

```bash
# 启动
pm2 start start.mjs --name claude-relay-service

# 查看状态
pm2 status

# 查看日志
pm2 logs claude-relay-service

# 停止
pm2 stop claude-relay-service

# 重启
pm2 restart claude-relay-service
```

### Windows 下使用 PM2

如果在 Windows 下使用 PM2 遇到问题，可以显式指定解释器：

```cmd
pm2 start start.mjs --name claude-relay-service --interpreter node
```

## 🐛 故障排除

### Windows 常见问题

#### 1. npm 命令找不到

确保 Node.js 已正确安装并添加到 PATH：

```cmd
node --version
npm --version
```

#### 2. 颜色显示异常

在 PowerShell 或 CMD 中运行时，确保使用的是 Windows 10 或更新版本。

#### 3. 权限错误

使用管理员权限运行 PowerShell 或 CMD。

### Linux / macOS 常见问题

#### 1. 权限被拒绝

为脚本添加执行权限：

```bash
chmod +x start.mjs
```

#### 2. Node.js 版本过低

确保 Node.js 版本 >= 18.0.0：

```bash
node --version
```

## 📊 与原有启动方式对比

| 特性         | `npm start` | `node start.mjs` |
| ------------ | ----------- | ---------------- |
| 模块格式     | CommonJS    | ESM              |
| 平台检测     | ❌          | ✅               |
| 环境检查     | ❌          | ✅               |
| Windows 优化 | ❌          | ✅               |
| 彩色输出     | 基础        | 增强             |
| 帮助文档     | ❌          | ✅               |
| 进度提示     | 简单        | 详细             |

## 💡 最佳实践

1. **开发环境**: 使用 `node start.mjs` 可以看到详细的启动过程
2. **生产环境**: 使用 `node start.mjs --skip-lint` 跳过检查以加快启动
3. **持续运行**: 使用 PM2 进行进程管理
4. **调试模式**: 查看完整的启动日志来诊断问题

## 🔗 相关文档

- [项目主文档](./CLAUDE.md)
- [Docker 部署指南](./.github/DOCKER_HUB_SETUP.md)
- [发布流程](./.github/RELEASE_PROCESS.md)

## 📝 许可证

MIT License - 与主项目相同
