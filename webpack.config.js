const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    entry: {
      hub: './src/index.tsx',
      settings: './src/settings/index.tsx'
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
      new webpack.DefinePlugin({
        'process.env.ENABLE_LICENSE_ENFORCEMENT': JSON.stringify(
          process.env.ENABLE_LICENSE_ENFORCEMENT || ''
        ),
      }),
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
      })
    ]
  };
};
