const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const { ModuleFederationPlugin } = webpack.container;
const packageJson = require("./package.json");
const federationName = packageJson.name.replace(/[-@/]/g, "_");

module.exports = (env, argv) => {
  const isProduction = argv.mode === "production";

  return {
    entry: "./src/webapp/main.tsx",

    mode: isProduction ? "production" : "development",

    output: {
      path: path.resolve(__dirname, "public"),
      filename: isProduction ? "[name].[contenthash].js" : "[name].js",
      clean: true,
      publicPath: "auto"
    },

    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "ts-loader",
            options: {
              configFile: "tsconfig.webapp.json"
            }
          }
        },
        {
          test: /\.css$/,
          use: [isProduction ? MiniCssExtractPlugin.loader : "style-loader", "css-loader"]
        },
        {
          test: /\.(png|jpg|gif|svg)$/,
          type: "asset/resource"
        }
      ]
    },

    plugins: [
      new ModuleFederationPlugin({
        // MUST NOT contain spaces
        name: federationName,

        library: {
          type: "var",
          name: federationName
        },

        filename: "remoteEntry.js",

        exposes: {
          "./PluginConfigurationPanel": "./src/webapp/components/PluginConfigurationPanel"
        },

        // Share React with the SignalK admin UI host. The configuration panel
        // is rendered by the host app, so hooks must resolve to the host's
        // singleton React when one is present. Keep a local fallback for the
        // standalone runtime UI without enforcing the package's dev React
        // version against the host.
        shared: {
          react: {
            singleton: true,
            requiredVersion: false
          },
          "react-dom": {
            singleton: true,
            requiredVersion: false
          }
        }
      }),

      new HtmlWebpackPlugin({
        template: "./src/webapp/index.html",
        filename: "index.html",
        title: "SignalK Edge Link Configuration"
      }),

      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, "src/icons"),
            to: path.resolve(__dirname, "public/icons"),
            noErrorOnMissing: true
          }
        ]
      }),

      ...(isProduction
        ? [
          new MiniCssExtractPlugin({
            filename: "[name].[contenthash].css"
          })
        ]
        : [])
    ],

    // Production: emit no source maps at all. The published package ships the
    // production bundle via the package.json "files" allowlist, which overrides
    // .npmignore for whitelisted trees — so any emitted .map files would be
    // published (bloating the tarball ~4x) regardless of .npmignore. Omitting
    // them is the only robust way to keep maps out of the registry.
    // Development keeps fast in-memory maps for local debugging.
    devtool: isProduction ? false : "eval-source-map",

    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"]
    }
  };
};
