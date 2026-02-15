const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const { ModuleFederationPlugin } = webpack.container;
const packageJson = require("./package.json");

module.exports = (env, argv) => {
  const isProduction = argv.mode === "production";

  return {
    // IMPORTANT: webapp is the runtime entry
    entry: "./src/webapp/index.js",

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
          test: /\.jsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
            options: {
              presets: ["@babel/preset-env", "@babel/preset-react"]
            }
          }
        },
        {
          test: /\.css$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : "style-loader",
            "css-loader"
          ]
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
        name: "signalk_data_connector",

        library: {
          type: "var",
          name: packageJson.name.replace(/[-@/]/g, "_")
        },

        filename: "remoteEntry.js",

        exposes: {
          "./PluginConfigurationPanel": "./src/components/PluginConfigurationPanel"
        },

        // CRITICAL FIX
        shared: {
          react: {
            singleton: true,
            requiredVersion: packageJson.dependencies.react
          },
          "react-dom": {
            singleton: true,
            requiredVersion: packageJson.dependencies["react-dom"]
          }
        }
      }),

      new HtmlWebpackPlugin({
        template: "./src/webapp/index.html",
        filename: "index.html",
        title: "SignalK Data Connector Configuration"
      }),

      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, "src/webapp/icons"),
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

    devtool: isProduction ? "source-map" : "eval-source-map",

    resolve: {
      extensions: [".js", ".jsx", ".json"]
    }
  };
};
