// VS Code loads a CommonJS entry; application code remains ESM.
exports.activate = async (context) => {
  const { activate } = await import('./src/extension.js');
  return activate(context, require('vscode'));
};
