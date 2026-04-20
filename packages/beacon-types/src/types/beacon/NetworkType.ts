export enum NetworkType {
  MAINNET = 'mainnet',
  /** @deprecated Ghostnet is succeeded by shadownet. */
  GHOSTNET = 'ghostnet',
  WEEKLYNET = 'weeklynet', // Testnet, resets every week
  DAILYNET = 'dailynet', // Testnet, resets every day
  /** @deprecated Seoulnet is succeeded by tallinnnet. */
  SEOULNET = 'seoulnet',
  SHADOWNET = 'shadownet',
  TALLINNNET = 'tallinnnet',
  TEZLINK_SHADOWNET = 'tezlink-shadownet',
  TEZOSX_PREVIEWNET = 'tezosx-previewnet',
  USHUAIANET = 'ushuaianet',
  CUSTOM = 'custom'
}
