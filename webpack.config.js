const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    entry: {
      hub: './src/index.tsx',
      settings: './src/settings/index.tsx',
      license: './src/license/index.tsx'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: false // Don't clean dist folder (backend files are there)
    },
    target: 'web',
    mode: isProduction ? 'production' : 'development',
    devtool: isProduction ? false : 'source-map',
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx']
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/
        }
      ]
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/hub/hub.html',
        filename: 'hub.html',
        chunks: ['hub'],
        inject: 'body'
      }),
      new HtmlWebpackPlugin({
        template: './src/settings/settings.html',
        filename: 'settings.html',
        chunks: ['settings'],
        inject: 'body'
      }),
      new HtmlWebpackPlugin({
        template: './src/license/license.html',
        filename: 'license.html',
        chunks: ['license'],
        inject: 'body'
      })
    ]
  };
};
