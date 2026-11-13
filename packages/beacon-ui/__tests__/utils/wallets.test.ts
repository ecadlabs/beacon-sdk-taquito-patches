import { mergeWallets, Wallet } from '../../src/utils/wallets'

it('keeps wallet platform links and description precedence when merging variants', () => {
  const web: Wallet = {
    id: 'web',
    key: 'example-web',
    name: 'Example',
    image: 'logo',
    description: 'Web',
    type: 'web',
    link: 'https://wallet.example',
    deepLink: 'web://'
  }
  const firefox: Wallet = {
    ...web,
    id: 'firefox',
    key: 'example-firefox',
    description: 'Extension',
    type: 'extension',
    link: 'https://addons.example',
    deepLink: 'firefox://'
  }
  const chrome: Wallet = { ...firefox, id: 'chrome', key: 'example-chrome', deepLink: 'chrome://' }
  expect(mergeWallets([web, firefox, chrome])).toEqual([
    {
      ...web,
      descriptions: ['Web', 'Extension'],
      types: ['web', 'extension', 'extension'],
      links: ['https://wallet.example', '', '', 'https://addons.example'],
      firefoxId: 'firefox',
      deepLink: 'chrome://'
    }
  ])
})
