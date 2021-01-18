const fetch = require("node-fetch");
const core = require("@actions/core");
const toolCache = require("@actions/tool-cache");
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");

async function setupApacheFlex() {
  try {
    var flexVersion = core.getInput("flex-version");
    if (!flexVersion) {
      flexVersion = "4.16.1";
    } else if (!/^\d+\.\d+.\d+$/.test(flexVersion)) {
      throw new Error("Invalid Apache Flex version: " + flexVersion);
    }
    console.log("Apache Flex version: " + flexVersion);

    var installLocation = process.platform.startsWith("win")
      ? "c:\\ApacheFlexSDK"
      : "/usr/local/bin/ApacheFlexSDK";

    var flexPlatform = null;
    const baseFileName = `apache-flex-sdk-${flexVersion}-bin`;
    var filename = baseFileName;
    if (process.platform.startsWith("darwin")) {
      flexPlatform = "mac";
      filename += ".tar.gz";
    } else if (process.platform.startsWith("win")) {
      flexPlatform = "win";
      filename += ".zip";
    } else {
      throw new Error("Apache Flex SDK setup is not supported on Linux");
    }
    console.log("Apache Flex platform: " + flexPlatform);

    const mirrorUrl = "http://flex.apache.org/single-mirror-url--xml.cgi";

    const mirrorResponse = await fetch(mirrorUrl);
    if (!mirrorResponse.ok) {
      throw new Error("Failed to load mirror for Apache Flex SDK");
    }
    const mirror = await mirrorResponse.text();

    var archiveUrl = `${mirror}/flex/${flexVersion}/binaries/${filename}`;

    var downloadedPath = await toolCache.downloadTool(archiveUrl, filename);
    fs.mkdirSync(installLocation);

    if (process.platform.startsWith("darwin")) {
      await toolCache.extractTar(downloadedPath, installLocation);
    } else if (process.platform.startsWith("win")) {
      await toolCache.extractZip(downloadedPath, installLocation);
    }

    var flexHome = installLocation;
    if (process.platform.startsWith("darwin")) {
      flexHome = path.resolve(installLocation, baseFileName);
    }
    core.addPath(path.resolve(flexHome, "bin"));
    core.exportVariable("FLEX_HOME", flexHome);

    child_process.execSync(
      "ant -f installer.xml -Dflash.sdk.version=32.0 -Dair.sdk.version=32.0 -Dinstaller=true -Ddo.flash.install=1 -Ddo.air.install=1 -Ddo.swfobject.install=1 -Ddo.fontswf.install=1 -Ddo.osmf.install=1 -Ddo.ofl.install=1",
      {
        cwd: flexHome,
        stdio: "inherit",
      }
    );
  } catch (error) {
    core.setFailed(error.message);
  }
}
setupApacheFlex();