import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AbiCoder,
  BrowserProvider,
  Contract,
  Interface,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from 'ethers'
import './App.css'

const BSC_TESTNET_CHAIN_ID = 97n
const BSC_TESTNET_CHAIN_HEX = '0x61'
const MASTERCHEF_ADDRESS = '0x9E9B91e321B1E30F47971b840C388b410c21FD9d'

const ACTIVE_POOL = {
  pid: 0n,
  name: 'WETH Pool',
}

const BSC_TESTNET_PARAMS = {
  chainId: BSC_TESTNET_CHAIN_HEX,
  chainName: 'BSC Testnet',
  nativeCurrency: {
    name: 'tBNB',
    symbol: 'tBNB',
    decimals: 18,
  },
  rpcUrls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
  blockExplorerUrls: ['https://testnet.bscscan.com'],
}

const ERC20_READ_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]

const ERC20_WRITE_ABI = ['function approve(address,uint256) returns (bool)']
const WRAPPED_NATIVE_ABI = ['function deposit() payable']

const CHEF_WRITE_ABI = [
  'function deposit(uint256,uint256)',
  'function withdraw(uint256,uint256)',
  'function harvest(uint256)',
  'function harvest(uint256,address)',
]

const abiCoder = AbiCoder.defaultAbiCoder()

type EIP1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

type EIP6963ProviderInfo = {
  uuid: string
  name: string
  icon: string
  rdns: string
}

type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo
  provider: EIP1193Provider
}

type ModalMode = 'stake' | 'unstake' | 'wrap' | null

declare global {
  interface WindowEventMap {
    'eip6963:announceProvider': CustomEvent<EIP6963ProviderDetail>
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'object' && error !== null && 'shortMessage' in error) {
    const maybeMessage = (error as { shortMessage?: unknown }).shortMessage
    if (typeof maybeMessage === 'string') {
      return maybeMessage
    }
  }
  return '未知错误'
}

function formatAmount(amount: bigint, decimals: number, precision = 6): string {
  const formatted = formatUnits(amount, decimals)
  const [integer, fraction = ''] = formatted.split('.')
  const trimmed = fraction.slice(0, precision).replace(/0+$/, '')
  return trimmed ? `${integer}.${trimmed}` : integer
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function parseAmountInput(input: string, decimals: number): bigint {
  const value = input.trim()
  if (!value) {
    throw new Error('请输入数量')
  }
  return parseUnits(value, decimals)
}

async function ensureBscTestnet(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BSC_TESTNET_CHAIN_HEX }],
    })
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? Number((error as { code?: unknown }).code)
        : undefined

    if (code !== 4902) {
      throw error
    }

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [BSC_TESTNET_PARAMS],
    })
  }
}

async function fetchPoolTokenAddress(provider: BrowserProvider, pid: bigint): Promise<string> {
  const candidates = [
    'function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardBlock, uint256 accPerShare)',
    'function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardBlock, uint256 accPerShare, uint16 depositFeeBP)',
  ]

  for (const fragment of candidates) {
    try {
      const iface = new Interface([fragment])
      const data = iface.encodeFunctionData('poolInfo', [pid])
      const raw = await provider.call({ to: MASTERCHEF_ADDRESS, data })
      const decoded = abiCoder.decode(['address'], raw)
      return getAddress(decoded[0] as string)
    } catch {
      // Try next fragment.
    }
  }

  try {
    const iface = new Interface(['function lpToken(uint256) view returns (address)'])
    const data = iface.encodeFunctionData('lpToken', [pid])
    const raw = await provider.call({ to: MASTERCHEF_ADDRESS, data })
    const decoded = abiCoder.decode(['address'], raw)
    return getAddress(decoded[0] as string)
  } catch {
    throw new Error('无法读取池子的 LP Token 地址')
  }
}

async function fetchUserStakedAmount(provider: BrowserProvider, pid: bigint, user: string): Promise<bigint> {
  const candidates = [
    'function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt)',
    'function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt, uint256 fundedBy)',
  ]

  for (const fragment of candidates) {
    try {
      const iface = new Interface([fragment])
      const data = iface.encodeFunctionData('userInfo', [pid, user])
      const raw = await provider.call({ to: MASTERCHEF_ADDRESS, data })
      const decoded = abiCoder.decode(['uint256'], raw)
      return decoded[0] as bigint
    } catch {
      // Try next fragment.
    }
  }

  return 0n
}

async function fetchPendingReward(provider: BrowserProvider, pid: bigint, user: string): Promise<bigint> {
  const candidates = [
    {
      method: 'pendingCake',
      fragment: 'function pendingCake(uint256,address) view returns (uint256)',
    },
    {
      method: 'pendingReward',
      fragment: 'function pendingReward(uint256,address) view returns (uint256)',
    },
    {
      method: 'pendingToken',
      fragment: 'function pendingToken(uint256,address) view returns (uint256)',
    },
    {
      method: 'pendingSushi',
      fragment: 'function pendingSushi(uint256,address) view returns (uint256)',
    },
  ]

  for (const candidate of candidates) {
    try {
      const iface = new Interface([candidate.fragment])
      const data = iface.encodeFunctionData(candidate.method, [pid, user])
      const raw = await provider.call({ to: MASTERCHEF_ADDRESS, data })
      const decoded = abiCoder.decode(['uint256'], raw)
      return decoded[0] as bigint
    } catch {
      // Try next fragment.
    }
  }

  return 0n
}

async function harvestReward(
  provider: BrowserProvider,
  pid: bigint,
  account: string,
): Promise<{ hash: string; wait: () => Promise<void> }> {
  const signer = await provider.getSigner()

  try {
    const chef = new Contract(MASTERCHEF_ADDRESS, CHEF_WRITE_ABI, signer)
    const tx = await chef.harvest(pid, account)
    return { hash: tx.hash as string, wait: async () => void (await tx.wait()) }
  } catch {
    // Continue to fallback methods.
  }

  try {
    const chef = new Contract(MASTERCHEF_ADDRESS, CHEF_WRITE_ABI, signer)
    const tx = await chef.harvest(pid)
    return { hash: tx.hash as string, wait: async () => void (await tx.wait()) }
  } catch {
    // Continue to fallback methods.
  }

  const chef = new Contract(MASTERCHEF_ADDRESS, CHEF_WRITE_ABI, signer)
  const tx = await chef.deposit(pid, 0n)
  return { hash: tx.hash as string, wait: async () => void (await tx.wait()) }
}

function App() {
  const walletMapRef = useRef<Map<string, EIP6963ProviderDetail>>(new Map())
  const walletMenuRef = useRef<HTMLDivElement | null>(null)

  const [wallets, setWallets] = useState<EIP6963ProviderDetail[]>([])
  const [activeWallet, setActiveWallet] = useState<EIP6963ProviderDetail | null>(null)
  const [browserProvider, setBrowserProvider] = useState<BrowserProvider | null>(null)

  const [account, setAccount] = useState<string>('')
  const [chainId, setChainId] = useState<bigint | null>(null)

  const [poolTokenAddress, setPoolTokenAddress] = useState<string>('')
  const [tokenSymbol, setTokenSymbol] = useState<string>('TOKEN')
  const [tokenDecimals, setTokenDecimals] = useState<number>(18)
  const [walletBalance, setWalletBalance] = useState<bigint>(0n)
  const [nativeBalance, setNativeBalance] = useState<bigint>(0n)
  const [allowance, setAllowance] = useState<bigint>(0n)
  const [stakedAmount, setStakedAmount] = useState<bigint>(0n)
  const [pendingReward, setPendingReward] = useState<bigint>(0n)

  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState<boolean>(false)
  const [modalMode, setModalMode] = useState<ModalMode>(null)
  const [modalAmount, setModalAmount] = useState<string>('')

  const [, setInfoMessage] = useState<string>('请先连接钱包')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [busyAction, setBusyAction] = useState<string>('')

  const isConnected = Boolean(activeWallet && browserProvider && account)
  const isOnBscTestnet = chainId === BSC_TESTNET_CHAIN_ID

  const effectiveTokenAddress = useMemo(() => {
    if (!isAddress(poolTokenAddress)) {
      return ''
    }
    return getAddress(poolTokenAddress)
  }, [poolTokenAddress])

  const disconnectWallet = useCallback(
    async (attemptRevoke = true) => {
      if (attemptRevoke && activeWallet?.provider) {
        try {
          await activeWallet.provider.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }],
          })
        } catch {
          // Most wallets do not support revoke; app-level disconnect is enough.
        }
      }

      setActiveWallet(null)
      setBrowserProvider(null)
      setIsWalletMenuOpen(false)
      setAccount('')
      setChainId(null)
      setPoolTokenAddress('')
      setTokenSymbol('TOKEN')
      setTokenDecimals(18)
      setWalletBalance(0n)
      setNativeBalance(0n)
      setAllowance(0n)
      setStakedAmount(0n)
      setPendingReward(0n)
      setModalMode(null)
      setModalAmount('')
      setInfoMessage('已断开连接')
      setErrorMessage('')
    },
    [activeWallet],
  )

  const refreshData = useCallback(async () => {
    if (!browserProvider || !account) {
      return
    }

    setBusyAction('refresh')
    setErrorMessage('')

    try {
      const discoveredToken = await fetchPoolTokenAddress(browserProvider, ACTIVE_POOL.pid)
      setPoolTokenAddress(discoveredToken)

      const token = new Contract(discoveredToken, ERC20_READ_ABI, browserProvider)
      const [symbolRaw, decimalsRaw, balanceRaw, nativeBalanceRaw, allowanceRaw, stakedRaw, pendingRaw] =
        await Promise.all([
          token.symbol() as Promise<string>,
          token.decimals() as Promise<number>,
          token.balanceOf(account) as Promise<bigint>,
          browserProvider.getBalance(account),
          token.allowance(account, MASTERCHEF_ADDRESS) as Promise<bigint>,
          fetchUserStakedAmount(browserProvider, ACTIVE_POOL.pid, account),
          fetchPendingReward(browserProvider, ACTIVE_POOL.pid, account),
        ])

      setTokenSymbol(symbolRaw)
      setTokenDecimals(Number(decimalsRaw))
      setWalletBalance(balanceRaw)
      setNativeBalance(nativeBalanceRaw)
      setAllowance(allowanceRaw)
      setStakedAmount(stakedRaw)
      setPendingReward(pendingRaw)
      setInfoMessage('链上数据已更新')
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction('')
    }
  }, [account, browserProvider])

  const connectWallet = useCallback(async (detail: EIP6963ProviderDetail) => {
    setIsWalletMenuOpen(false)
    setBusyAction('connect')
    setErrorMessage('')

    try {
      await detail.provider.request({ method: 'eth_requestAccounts' })
      await ensureBscTestnet(detail.provider)

      const provider = new BrowserProvider(detail.provider, 'any')
      const signer = await provider.getSigner()
      const currentAccount = getAddress(await signer.getAddress())
      const network = await provider.getNetwork()

      setActiveWallet(detail)
      setBrowserProvider(provider)
      setAccount(currentAccount)
      setChainId(network.chainId)
      setInfoMessage(`已连接 ${detail.info.name}`)
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction('')
    }
  }, [])

  const handleWalletButtonClick = useCallback(async () => {
    if (isConnected) {
      setIsWalletMenuOpen((prev) => !prev)
      return
    }

    if (wallets.length === 1) {
      await connectWallet(wallets[0])
      return
    }

    if (wallets.length > 1) {
      setIsWalletMenuOpen((prev) => !prev)
      return
    }

    setErrorMessage('未发现 EIP-6963 钱包，请先安装或打开钱包扩展。')
  }, [connectWallet, isConnected, wallets])

  const handleApprove = useCallback(
    async (amountInput: string) => {
      if (!browserProvider || !isConnected) {
        return
      }

      if (!effectiveTokenAddress) {
        setErrorMessage('未读取到质押 Token 地址，请稍后重试')
        return
      }

      try {
        setBusyAction('approve')
        setErrorMessage('')

        const amount = parseAmountInput(amountInput, tokenDecimals)
        const signer = await browserProvider.getSigner()
        const token = new Contract(effectiveTokenAddress, ERC20_WRITE_ABI, signer)

        const tx = await token.approve(MASTERCHEF_ADDRESS, amount)
        setInfoMessage(`授权交易已发送: ${tx.hash}`)
        await tx.wait()
        setInfoMessage('授权成功')
        await refreshData()
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setBusyAction('')
      }
    },
    [browserProvider, effectiveTokenAddress, isConnected, refreshData, tokenDecimals],
  )

  const handleStake = useCallback(
    async (amountInput: string) => {
      if (!browserProvider || !isConnected) {
        return
      }

      try {
        const amount = parseAmountInput(amountInput, tokenDecimals)
        if (allowance < amount) {
          throw new Error('授权额度不足，请先点击 Approve')
        }

        setBusyAction('stake')
        setErrorMessage('')

        const signer = await browserProvider.getSigner()
        const chef = new Contract(MASTERCHEF_ADDRESS, CHEF_WRITE_ABI, signer)
        const tx = await chef.deposit(ACTIVE_POOL.pid, amount)

        setInfoMessage(`质押交易已发送: ${tx.hash}`)
        await tx.wait()
        setInfoMessage('质押成功')
        setModalMode(null)
        setModalAmount('')
        await refreshData()
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setBusyAction('')
      }
    },
    [allowance, browserProvider, isConnected, refreshData, tokenDecimals],
  )

  const handleUnstake = useCallback(
    async (amountInput: string) => {
      if (!browserProvider || !isConnected) {
        return
      }

      try {
        const amount = parseAmountInput(amountInput, tokenDecimals)

        setBusyAction('unstake')
        setErrorMessage('')

        const signer = await browserProvider.getSigner()
        const chef = new Contract(MASTERCHEF_ADDRESS, CHEF_WRITE_ABI, signer)
        const tx = await chef.withdraw(ACTIVE_POOL.pid, amount)

        setInfoMessage(`赎回交易已发送: ${tx.hash}`)
        await tx.wait()
        setInfoMessage('赎回成功')
        setModalMode(null)
        setModalAmount('')
        await refreshData()
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setBusyAction('')
      }
    },
    [browserProvider, isConnected, refreshData, tokenDecimals],
  )

  const handleClaim = useCallback(async () => {
    if (!browserProvider || !isConnected || !account) {
      return
    }

    try {
      setBusyAction('claim')
      setErrorMessage('')

      const tx = await harvestReward(browserProvider, ACTIVE_POOL.pid, account)
      setInfoMessage(`领取奖励交易已发送: ${tx.hash}`)
      await tx.wait()
      setInfoMessage('奖励领取成功')
      await refreshData()
    } catch (error) {
      setErrorMessage(formatError(error))
    } finally {
      setBusyAction('')
    }
  }, [account, browserProvider, isConnected, refreshData])

  const handleWrapNative = useCallback(
    async (amountInput: string) => {
      if (!browserProvider || !isConnected) {
        return
      }

      if (!effectiveTokenAddress) {
        setErrorMessage('未读取到 WETH 地址，请先刷新后重试')
        return
      }

      try {
        const amount = parseAmountInput(amountInput, 18)
        setBusyAction('wrap')
        setErrorMessage('')

        const signer = await browserProvider.getSigner()
        const wrappedNative = new Contract(effectiveTokenAddress, WRAPPED_NATIVE_ABI, signer)
        const tx = await wrappedNative.deposit({ value: amount })

        setInfoMessage(`Wrap 交易已发送: ${tx.hash}`)
        await tx.wait()
        setInfoMessage('Wrap 成功')
        setModalMode(null)
        setModalAmount('')
        await refreshData()
      } catch (error) {
        setErrorMessage(formatError(error))
      } finally {
        setBusyAction('')
      }
    },
    [browserProvider, effectiveTokenAddress, isConnected, refreshData],
  )

  const openModal = useCallback((mode: Exclude<ModalMode, null>) => {
    setModalMode(mode)
    setModalAmount('')
    setErrorMessage('')
  }, [])

  useEffect(() => {
    const handleAnnounceProvider = (event: Event) => {
      const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail
      if (!detail?.info?.uuid || walletMapRef.current.has(detail.info.uuid)) {
        return
      }

      walletMapRef.current.set(detail.info.uuid, detail)
      setWallets(Array.from(walletMapRef.current.values()))
    }

    window.addEventListener('eip6963:announceProvider', handleAnnounceProvider)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    return () => {
      window.removeEventListener('eip6963:announceProvider', handleAnnounceProvider)
    }
  }, [])

  useEffect(() => {
    if (!activeWallet) {
      return
    }

    const { provider } = activeWallet

    const handleAccountsChanged = (accounts: unknown) => {
      if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') {
        void disconnectWallet(false)
        return
      }

      try {
        setAccount(getAddress(accounts[0]))
      } catch {
        void disconnectWallet(false)
      }
    }

    const handleChainChanged = (newChainId: unknown) => {
      if (typeof newChainId !== 'string') {
        return
      }

      try {
        setChainId(BigInt(newChainId))
      } catch {
        setChainId(null)
      }
    }

    provider.on?.('accountsChanged', handleAccountsChanged)
    provider.on?.('chainChanged', handleChainChanged)

    return () => {
      provider.removeListener?.('accountsChanged', handleAccountsChanged)
      provider.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [activeWallet, disconnectWallet])

  useEffect(() => {
    if (isConnected && isOnBscTestnet) {
      void refreshData()
    }
  }, [isConnected, isOnBscTestnet, refreshData])

  useEffect(() => {
    if (!isWalletMenuOpen) {
      return
    }

    const onClickOutside = (event: MouseEvent) => {
      if (!walletMenuRef.current) {
        return
      }
      if (!walletMenuRef.current.contains(event.target as Node)) {
        setIsWalletMenuOpen(false)
      }
    }

    window.addEventListener('click', onClickOutside)
    return () => window.removeEventListener('click', onClickOutside)
  }, [isWalletMenuOpen])

  useEffect(() => {
    if (!modalMode) {
      return
    }

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModalMode(null)
        setModalAmount('')
      }
    }

    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [modalMode])

  const modalInputDecimals = modalMode === 'wrap' ? 18 : tokenDecimals
  const modalMax = modalMode === 'stake' ? walletBalance : modalMode === 'unstake' ? stakedAmount : nativeBalance
  const modalBalanceSymbol = modalMode === 'wrap' ? 'BNB' : tokenSymbol
  const parsedModalAmount = useMemo(() => {
    if (!modalAmount.trim()) {
      return null
    }

    try {
      return parseAmountInput(modalAmount, modalInputDecimals)
    } catch {
      return null
    }
  }, [modalAmount, modalInputDecimals])
  const needsApproval =
    modalMode === 'stake' && parsedModalAmount !== null && parsedModalAmount > 0n && allowance < parsedModalAmount

  return (
    <main className="farm-page">
      <header className="farm-nav">
        <div className="brand">Token Staking</div>
        <div className="farm-nav-right">
          {isConnected && (
            <span className={isOnBscTestnet ? 'chain-pill ok' : 'chain-pill bad'}>
              {chainId !== null ? `Chain ${chainId.toString()}` : '未连接网络'}
            </span>
          )}
          <div className="wallet-top" ref={walletMenuRef}>
            <button
              className="wallet-main-btn"
              type="button"
              onClick={() => void handleWalletButtonClick()}
              disabled={busyAction !== ''}
            >
              {isConnected ? shortAddress(account) : busyAction === 'connect' ? '连接中...' : 'Connect Wallet'}
            </button>
            {isWalletMenuOpen && (
              <div className="wallet-dropdown">
                {isConnected ? (
                  <button
                    className="wallet-option"
                    type="button"
                    onClick={() => void disconnectWallet()}
                    disabled={busyAction !== ''}
                  >
                    断开连接
                  </button>
                ) : (
                  wallets.map((wallet) => (
                    <button
                      key={wallet.info.uuid}
                      className="wallet-option"
                      type="button"
                      onClick={() => void connectWallet(wallet)}
                      disabled={busyAction === 'connect'}
                    >
                      {wallet.info.icon ? <img src={wallet.info.icon} alt={wallet.info.name} /> : <span>W</span>}
                      {wallet.info.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <section className="hero-banner">
        <p className="eyebrow">MasterChef • BSC Testnet</p>
        <h1>Token Staking</h1>
      </section>

      <section className="farm-layout single">
        <article className="farm-card pool-card">
          <div className="pair-head">
            <div className="pair-icons">
              <span className="coin-a">W</span>
              <span className="coin-b">S</span>
            </div>
            <div>
              <div className="pool-title-row">
                <h2>{ACTIVE_POOL.name}</h2>
                <button
                  className="button-wrap"
                  type="button"
                  onClick={() => openModal('wrap')}
                  disabled={!isConnected || !isOnBscTestnet || busyAction !== '' || !effectiveTokenAddress}
                >
                  Wrap ETH
                </button>
              </div>
              <p className="subtle">MasterChef: {shortAddress(MASTERCHEF_ADDRESS)}</p>
            </div>
            <button
              className="button-ghost"
              type="button"
              onClick={() => void refreshData()}
              disabled={!isConnected || !isOnBscTestnet || busyAction !== ''}
            >
              {busyAction === 'refresh' ? '刷新中...' : '刷新'}
            </button>
          </div>

          <div className="metric-grid">
            <div>
              <span>Wallet Balance</span>
              <strong>
                {formatAmount(walletBalance, tokenDecimals)} {tokenSymbol}
              </strong>
            </div>
            <div>
              <span>Staked</span>
              <strong>
                {formatAmount(stakedAmount, tokenDecimals)} {tokenSymbol}
              </strong>
            </div>
            <div>
              <span>Pending Reward</span>
              <strong>{formatAmount(pendingReward, tokenDecimals)}</strong>
            </div>
            <div>
              <span>Token Address</span>
              <strong>{effectiveTokenAddress ? shortAddress(effectiveTokenAddress) : '-'}</strong>
            </div>
          </div>

          <div className="pool-actions">
            <button
              className="button-primary"
              type="button"
              onClick={() => openModal('stake')}
              disabled={!isConnected || !isOnBscTestnet || busyAction !== ''}
            >
              Stake
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => openModal('unstake')}
              disabled={!isConnected || !isOnBscTestnet || busyAction !== ''}
            >
              Unstake
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => void handleClaim()}
              disabled={!isConnected || !isOnBscTestnet || busyAction !== ''}
            >
              {busyAction === 'claim' ? '领取中...' : 'Harvest'}
            </button>
          </div>

          {errorMessage && <p className="status error">{errorMessage}</p>}
        </article>
      </section>

      {modalMode && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (busyAction === '') {
              setModalMode(null)
              setModalAmount('')
            }
          }}
        >
          <section className="modal-card" onClick={(event) => event.stopPropagation()}>
            <h3>
              {modalMode === 'stake' ? 'Stake Token' : modalMode === 'unstake' ? 'Unstake Token' : 'Wrap ETH'}
            </h3>
            <p className="subtle">
              {modalMode === 'wrap'
                ? `将 BNB 包装成 ${tokenSymbol || 'WETH'}`
                : `${ACTIVE_POOL.name} • PID ${ACTIVE_POOL.pid.toString()}`}
            </p>

            <div className="input-head">
              <span>Amount</span>
              <div className="input-head-right">
                <span className="balance-text">
                  Balance: {formatAmount(modalMax, modalInputDecimals)} {modalBalanceSymbol}
                </span>
                <button
                  className="link-btn"
                  type="button"
                  onClick={() => setModalAmount(formatUnits(modalMax, modalInputDecimals))}
                  disabled={!isConnected || busyAction !== ''}
                >
                  MAX
                </button>
              </div>
            </div>
            <input
              value={modalAmount}
              onChange={(event) => setModalAmount(event.target.value)}
              placeholder={`0.0 ${modalBalanceSymbol}`}
              autoFocus
            />

            <div className="modal-actions">
              {modalMode === 'stake' && needsApproval && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => void handleApprove(modalAmount)}
                  disabled={!isConnected || !isOnBscTestnet || busyAction !== '' || !modalAmount}
                >
                  {busyAction === 'approve' ? '授权中...' : 'Approve'}
                </button>
              )}

              <button
                className="button-primary"
                type="button"
                onClick={() =>
                  void (
                    modalMode === 'stake'
                      ? handleStake(modalAmount)
                      : modalMode === 'unstake'
                        ? handleUnstake(modalAmount)
                        : handleWrapNative(modalAmount)
                  )
                }
                disabled={
                  !isConnected ||
                  !isOnBscTestnet ||
                  busyAction !== '' ||
                  !modalAmount ||
                  parsedModalAmount === null ||
                  parsedModalAmount <= 0n ||
                  (modalMode === 'stake' && needsApproval)
                }
              >
                {modalMode === 'stake'
                  ? busyAction === 'stake'
                    ? '质押中...'
                    : 'Confirm Stake'
                  : modalMode === 'unstake'
                    ? busyAction === 'unstake'
                      ? '赎回中...'
                      : 'Confirm Unstake'
                    : busyAction === 'wrap'
                      ? '包装中...'
                      : 'Confirm Wrap'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
