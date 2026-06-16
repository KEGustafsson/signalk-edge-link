const webpackConfigFactory = require("../webpack.config");
const packageJson = require("../package.json");

describe("webpack Module Federation config", () => {
  test("uses the Signal K plugin package id as the remote container name", () => {
    const config = webpackConfigFactory({}, { mode: "production" });
    const expectedName = packageJson.name.replace(/[-@/]/g, "_");
    const federationPlugin = config.plugins.find(
      (plugin) => plugin.constructor && plugin.constructor.name === "ModuleFederationPlugin"
    );

    expect(federationPlugin).toBeDefined();
    expect(federationPlugin.options.name).toBe(expectedName);
    expect(federationPlugin.options.library).toEqual({
      type: "var",
      name: expectedName
    });
    expect(federationPlugin.options.filename).toBe("remoteEntry.js");
    expect(federationPlugin.options.exposes["./PluginConfigurationPanel"]).toBe(
      "./src/webapp/components/PluginConfigurationPanel"
    );
    expect(federationPlugin.options.shared.react).toMatchObject({
      singleton: true,
      requiredVersion: false
    });
    expect(federationPlugin.options.shared["react-dom"]).toMatchObject({
      singleton: true,
      requiredVersion: false
    });
  });
});
