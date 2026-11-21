// Expo detects the pnpm workspace and watches packages/shared automatically.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
