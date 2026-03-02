# 质押页面（BSC Testnet）

这是一个基于 `React + TypeScript + Vite + ethers` 的前端项目，用于与 MasterChef 合约交互，实现 WETH 质押与奖励领取。

- MasterChef 合约地址：`0x9E9B91e321B1E30F47971b840C388b410c21FD9d`
- 网络：`BSC Testnet`（Chain ID: `97` / `0x61`）
- 钱包连接：支持 `EIP-6963`（多钱包发现）
- 连接后支持断开连接

## 功能

- 自动发现并连接支持 EIP-6963 的浏览器钱包
- 自动切换/添加 BSC Testnet 网络
- 输入 `PID` 后读取池子信息
- 授权（`approve`）
- 质押（`deposit`）
- 赎回（`withdraw`）
- 领取奖励（`harvest`，兼容 `deposit(pid, 0)` 回退）

## 环境要求

- Node.js 18+
- Yarn 1.x 或 Yarn Berry（本项目已用 Yarn 安装）

## 安装依赖

```bash
yarn
```

## 启动项目（开发模式）

```bash
yarn dev
```

启动后在浏览器打开终端提示的本地地址（通常是 `http://localhost:5173`）。

## 构建生产包

```bash
yarn build
```

## 本地预览生产包

```bash
yarn preview
```

## 使用说明

1. 打开页面后，点击“连接钱包”。
2. 选择钱包并授权连接。
3. 钱包会自动切换到 BSC Testnet（如未添加会提示添加网络）。
4. 输入目标池子的 `PID`，点击“刷新链上数据”。
5. 输入质押数量后先“授权”，再“质押”。
6. 需要退出时点击“断开连接”。

## 说明

- 不同 MasterChef 实现可能存在 ABI 差异，页面已做常见方法兼容。
- 若自动读取质押 Token 地址失败，可手动填写 Token 地址后继续操作。

## GitHub Pages 部署

仓库已添加自动部署工作流：`.github/workflows/deploy-pages.yml`。

首次启用请在 GitHub 仓库中操作：

1. 进入 `Settings` -> `Pages`
2. `Source` 选择 `GitHub Actions`
3. 推送代码到 `main`（或 `master`）分支，等待工作流执行完成

部署成功后访问：

- `https://dericklau3.github.io/token-staking-interface/`
