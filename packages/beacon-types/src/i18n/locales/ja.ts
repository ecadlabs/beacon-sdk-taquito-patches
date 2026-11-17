import { BeaconErrorType } from '../../types/BeaconErrorType'
import { BeaconLocaleMessages } from '../schema'

export const jaMessages = {
  meta: {
    locale: 'ja',
    name: '日本語',
    direction: 'ltr',
    status: 'ai-draft'
  },
  errors: {
    [BeaconErrorType.BROADCAST_ERROR]: {
      title: 'ブロードキャストエラー',
      description: 'トランザクションをネットワークに送信できませんでした。もう一度お試しください。'
    },
    [BeaconErrorType.NETWORK_NOT_SUPPORTED]: {
      title: 'ネットワークエラー',
      description:
        'ウォレットはこのネットワークをサポートしていません。別のネットワークを選択してください。'
    },
    [BeaconErrorType.NO_ADDRESS_ERROR]: {
      title: 'アドレスエラー',
      description:
        'このネットワークに対応するアカウントが見つかりませんでした。ウォレットでネットワークまたはアカウントを切り替えてから再試行してください。'
    },
    [BeaconErrorType.NO_PRIVATE_KEY_FOUND_ERROR]: {
      title: '秘密鍵が見つかりません',
      description:
        '操作しようとしているアカウントが利用できません。ウォレットにアカウントが追加されていることを確認して再試行してください。'
    },
    [BeaconErrorType.NOT_GRANTED_ERROR]: {
      title: '権限がありません',
      description:
        'この操作を実行するために必要な権限がありません。再度権限リクエストを行い、必要な権限を付与してください。'
    },
    [BeaconErrorType.PARAMETERS_INVALID_ERROR]: {
      title: '無効なパラメータ',
      description:
        '指定されたパラメータの一部が無効なため、リクエストを完了できませんでした。入力内容を確認して再試行してください。'
    },
    [BeaconErrorType.TOO_MANY_OPERATIONS]: {
      title: 'オペレーションが多すぎます',
      description:
        'リクエストに含まれるトランザクションが多すぎます。オペレーションの数を減らして再試行してください。'
    },
    [BeaconErrorType.TRANSACTION_INVALID_ERROR]: {
      title: '無効なトランザクション',
      description: 'トランザクションが無効であり、ノードに受け入れられませんでした。'
    },
    [BeaconErrorType.SIGNATURE_TYPE_NOT_SUPPORTED]: {
      title: 'サポートされていない署名タイプ',
      description: 'ウォレットはこの形式のペイロードに署名できません。'
    },
    [BeaconErrorType.ABORTED_ERROR]: {
      title: '中断されました',
      description: 'ユーザーによって操作がキャンセルされました。'
    },
    [BeaconErrorType.PEER_UNREACHABLE]: {
      title: 'ウォレットからの応答がありません',
      description:
        'ウォレットが時間内に応答しませんでした。リクエストがウォレット内で開いたままになっており、承認可能な状態の可能性があります。再試行する前にウォレットと最近のアカウント履歴を確認してください。'
    },
    [BeaconErrorType.UNKNOWN_ERROR]: {
      title: 'エラー',
      description: '不明なエラーが発生しました。再試行するか、開発者に報告してください。'
    }
  },
  dapp: {
    requestSent: '{{wallet}} にリクエストを送信しました',
    noAnswerFromWallet:
      'ウォレットからの応答がまだありません。ウォレットが開いていることを確認してください。',
    walletNotReceivingRequest: 'ウォレットにリクエストが届きませんか？',
    resetConnection: '接続をリセット',
    awaitingConfirmation: '{{wallet}} での確認を待っています',
    preparingRequestForWallet: '{{wallet}} へのリクエストを準備中...',
    preparingRequest: 'リクエストを準備中...',
    noPermissionTitle: '権限がありません',
    noPermissionBody: 'この種類のリクエストを処理できるようウォレットで許可してください。',
    invalidStateTitle: '無効な状態',
    invalidStateBody: `アクティブなアカウントを受信しましたが、BeaconEvent.ACTIVE_ACCOUNT_SET の有効なサブスクリプションが見つかりませんでした。
    詳細はこちらをご覧ください: https://docs.walletbeacon.io/guides/migration-guide`,
    errorTitle: 'エラー',
    sessionExpiredBody:
      'セッションの有効期限が切れました。再度ウォレットとペアリングしてください。',
    pleaseTryAgain: 'もう一度お試しください。',
    walletReturnedError: '{{wallet}} がエラーを返しました',
    walletDidNotRespond: '{{wallet}} が応答しませんでした',
    walletRequestCancelled: '{{wallet}} のリクエストがキャンセルされました',
    walletRequestFailed: '{{wallet}} のリクエストが失敗しました',
    showDetails: '詳細を表示',
    rateLimitReachedBody: 'レート制限に達しました。少し待ってから再試行してください',
    done: '完了',
    relayerErrorBody:
      'リレイヤーへの接続に失敗しました。システム時刻が現在の時刻と同期していることを確認し、ページを再読み込みしてください。',
    lateBroadcastToast:
      'リクエストのタイムアウト後に {{wallet}} がトランザクションをブロードキャストしました',
    lateOperationToast: 'リクエストのタイムアウト後に {{wallet}} がオペレーションを送信しました',
    copyToClipboard: 'クリップボードにコピー',
    internalErrorTitle: '内部エラー',
    choosePreferredWallet: '使用するウォレットを選択してください',
    addressLabel: 'アドレス',
    networkLabel: 'ネットワーク',
    permissionsLabel: '権限',
    permissionGrantedToast: '{{wallet}} が権限を承認しました',
    challengeAcceptedToast: '{{wallet}} がチャレンジを承認しました',
    challengeRefusedToast: '{{wallet}} がチャレンジを拒否しました',
    payloadHashLabel: 'ペイロードハッシュ: {{payloadHash}}',
    operationListReturnedToast: '{{wallet}} がオペレーション一覧を返しました',
    operationListLabel: 'オペレーション一覧',
    errorMessageLabel: 'エラーメッセージ',
    operationSubmittedToast: '{{wallet}} がオペレーションを正常に送信しました',
    openBlockexplorer: 'ブロックエクスプローラーを開く',
    payloadSignedToast: '{{wallet}} がペイロードに正常に署名しました',
    signatureLabel: '署名: {{signature}}',
    blockchainRequestExecutedToast: '{{wallet}} のリクエストが正常に実行されました',
    operationInjectedToast: '{{wallet}} がオペレーションを正常にインジェクトしました',
    unableToSendMessage:
      'メッセージを送信できませんでした。この問題が続く場合は、接続をリセットしてウォレットを再度ペアリングしてください。',
    noActiveAccount: 'アクティブなアカウントがありません！',
    noActiveAccountSet: 'アクティブなアカウントが設定されていません！',
    operationDetailsRequired: 'オペレーションの詳細を指定する必要があります',
    signedTransactionRequired: '署名済みトランザクションを指定する必要があります',
    payloadRequired: 'ペイロードを指定する必要があります',
    beaconIdNotDefined: 'BeaconIDが定義されていません'
  },
  ui: {
    connectWallet: 'ウォレットを接続',
    otherWallets: 'その他のウォレット',
    otherWalletsDescription: '接続に使用できる他のウォレットを表示します',
    showMore: 'もっと見る',
    showLess: '閉じる',
    pairWalletOnAnotherDevice: '別のデバイス上のウォレットとペアリング',
    showQrCode: 'QRコードを表示',
    selectQrType: 'QRコードの種類を選択',
    beaconQrOption: 'Beacon',
    walletConnectQrOption: 'WalletConnect',
    scanQrCode: 'QRコードをスキャン',
    notConnected: '未接続です。',
    orScanToConnect: 'またはスキャンして接続',
    openWalletAndScan: 'スマートフォンで {{wallet}} ウォレットを開いてスキャンしてください。',
    scanWithCompatibleWallet: '{{standard}} 対応ウォレットでQRコードをスキャンしてください。',
    preparingQrCode: '{{wallet}} のQRコードを準備中...',
    defaultWalletName: 'ウォレット',
    copyToClipboard: 'クリップボードにコピー',
    copied: 'コピーしました！',
    openWallet: 'ウォレットを開く',
    connectWithBrowserExtension: '{{wallet}} ブラウザ拡張機能で接続',
    installWallet: '{{wallet}} ウォレットをインストール',
    connectBrowserExtensionDescription:
      '下のボタンから {{wallet}} ウォレットのブラウザ拡張機能に接続してください。',
    installBrowserExtensionDescription:
      '{{wallet}} ウォレットを接続するには、ブラウザ拡張機能をインストールしてください。',
    useExtension: '拡張機能を使用',
    installExtension: '拡張機能をインストール',
    connectWithWeb: '{{wallet}} Webで接続',
    connectWithWebDescription: '（新しいタブでウォレットが開きます）',
    useBrowser: 'ブラウザを使用',
    connectWithDesktopApp: '{{wallet}} デスクトップアプリで接続',
    connectWithDesktopDescription:
      'デスクトップアプリがインストールされていない場合は、下からダウンロードしてください。',
    openDesktopApp: 'デスクトップアプリを開く',
    downloadDesktopApp: 'デスクトップアプリをダウンロード',
    connectWithMobile: '{{wallet}} モバイルで接続',
    connectWithMobileApp: '{{wallet}} {{suffix}} で接続',
    useApp: 'アプリを使用',
    getKukaiMobile: 'Kukai Mobileを入手 >',
    noTitle: 'タイトルなし',
    noDescription: '説明なし',
    close: '閉じる',
    walletTypes: {
      desktopApp: 'デスクトップアプリ',
      browserExtension: 'ブラウザ拡張機能',
      mobileApp: 'モバイルアプリ',
      webApp: 'Webアプリ'
    },
    walletConnectErrors: {
      'relay-unreachable': {
        heading: 'ネットワークエラーが発生しました。',
        body: 'WalletConnectリレイヤーに接続できませんでした。インターネット接続を確認して再試行してください。ファイアウォールやネットワークプロバイダーが接続をブロックしている場合は、VPN経由での接続をお試しください。',
        link: {
          label: '接続トラブルシューティングガイドを見る',
          url: 'https://docs.walletbeacon.io/guides/failed-to-connect'
        }
      },
      timeout: {
        heading: 'WalletConnectの接続がタイムアウトしました。',
        body: 'WalletConnectペアリングリクエストの準備中に接続がタイムアウトしました。もう一度お試しください。'
      },
      'origin-not-allowed': {
        heading: 'オリジンが許可されていません。',
        body: 'WalletConnectリレイヤーがこのドメインを拒否しました。dApp開発者の場合は、Reown (WalletConnect) Cloudダッシュボードの許可リストにこのオリジンを追加してください。'
      },
      'initialization-unavailable': {
        heading: 'WalletConnectは現在利用できません。',
        body: '前のセッションのクリーンアップ処理を実行中です。しばらく待ってから再試行してください。'
      },
      'client-replaced': {
        heading: 'WalletConnectセッションがリセットされました。',
        body: 'ペアリングコードの準備中にWalletConnectクライアントが置き換えられました。もう一度接続をお試しください。'
      },
      retired: {
        heading: 'ペアリングがキャンセルされました。',
        body: 'このWalletConnectペアリング試行はすでに無効です。新しい接続を開始してください。'
      }
    }
  },
  aria: {
    closeModal: '閉じる',
    goBack: '戻る',
    closeToast: '通知を閉じる',
    showQrCode: 'QRコードを表示',
    copyQrToClipboard: 'ペアリングコードをクリップボードにコピー',
    copiedToClipboard: 'クリップボードにコピーしました',
    qrCodeAlt: '{{wallet}} 用の {{standard}} ペアリングQRコード',
    walletLogoAlt: '{{wallet}} ロゴ',
    walletIconAlt: '{{wallet}} アイコン',
    otherWalletLogoAlt: 'その他のウォレット {{index}}',
    loading: '読み込み中'
  }
} as const satisfies BeaconLocaleMessages
