'use strict'

const getPrereleaseTag = (version) => {
  const prerelease = version.split('-')[1]

  if (!prerelease) {
    return undefined
  }

  return prerelease.split('.')[0]
}

const hasExplicitTagArg = (extraArgs) =>
  extraArgs.some((arg, index) => {
    if (arg === '--tag') {
      return true
    }

    if (index > 0 && extraArgs[index - 1] === '--tag') {
      return true
    }

    return arg.startsWith('--tag=')
  })

const resolvePublishTag = ({ version, extraArgs, env }) => {
  if (hasExplicitTagArg(extraArgs)) {
    return undefined
  }

  return env.NPM_DIST_TAG ?? getPrereleaseTag(version)
}

const resolvePublishCommand = ({ publishArgs, env, nodeExecPath }) => {
  const npmExecPath = env.npm_execpath

  if (npmExecPath) {
    return {
      command: nodeExecPath,
      args: [npmExecPath, ...publishArgs]
    }
  }

  return {
    command: 'npm',
    args: publishArgs
  }
}

module.exports = {
  getPrereleaseTag,
  hasExplicitTagArg,
  resolvePublishCommand,
  resolvePublishTag
}
