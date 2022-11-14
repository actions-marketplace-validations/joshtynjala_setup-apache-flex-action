// @ts-check
const fetch = require("node-fetch").default;
const { parseXml } = require("@rgrove/parse-xml");
const core = require("@actions/core");
const toolCache = require("@actions/tool-cache");
const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sdkConfigParseErrorText =
  "Failed to parse Apache Flex SDK configuration file";
const sdkConfigURL =
  "http://flex.apache.org/installer/sdk-installer-config-4.0.xml";

async function loadSDKConfig() {
  const sdkConfigResponse = await fetch(sdkConfigURL);
  if (!sdkConfigResponse.ok) {
    throw new Error("Failed to load Apache Flex SDK configuration file");
  }
  const sdkConfigText = await sdkConfigResponse.text();
  const sdkConfigXML = parseXml(sdkConfigText);
  return sdkConfigXML;
}

async function getMirrorURLPrefix(sdkConfigXML) {
  if (!sdkConfigXML || !("children" in sdkConfigXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const configXML = sdkConfigXML.children.find((child) => {
    return child.type === "element" && child.name === "config";
  });

  if (!configXML || !("children" in configXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const mirrorXML = configXML.children.find((child) => {
    return (
      child.type === "element" &&
      child.name === "mirror" &&
      "attributes" in child &&
      child.attributes.name === "MirrorURLCGI"
    );
  });

  if (!mirrorXML || !("attributes" in mirrorXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const mirrorCGIFileName = mirrorXML.attributes.file;
  const mirrorCGIURL = `https://flex.apache.org/${mirrorCGIFileName}`;

  const mirrorResponse = await fetch(mirrorCGIURL);
  if (!mirrorResponse.ok) {
    throw new Error("Failed to load mirror for Apache Flex SDK");
  }
  return await mirrorResponse.text();
}

function getFlexSDKProducts(sdkConfigXML) {
  if (!sdkConfigXML || !("children" in sdkConfigXML)) {
    throw new Error();
  }

  const configXML = sdkConfigXML.children.find((child) => {
    return child.type === "element" && child.name === "config";
  });

  if (!configXML || !("children" in configXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const productsXML = configXML.children.find((child) => {
    return child.type === "element" && child.name === "products";
  });

  if (!productsXML || !("children" in productsXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const apacheFlexXML = productsXML.children.find((child) => {
    return child.type === "element" && child.name === "ApacheFlexSDK";
  });

  if (!apacheFlexXML || !("attributes" in apacheFlexXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  return apacheFlexXML;
}

function getFlexVersionBestMatch(/** @type string */ expectedVersion, apacheFlexXML) {
  if (!apacheFlexXML || !("children" in apacheFlexXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const versionsXML = apacheFlexXML.children.find((child) => {
    return child.type === "element" && child.name === "versions";
  });

  if (!versionsXML || !("children" in versionsXML)) {
    throw new Error(sdkConfigParseErrorText);
  }

  const versionLettersXML = versionsXML.children.filter((child) => {
    return child.type === "element" && child.name.startsWith("version");
  });

  if (versionLettersXML.length === 0) {
    throw new Error(sdkConfigParseErrorText);
  }

  let bestMatch = null;
  const requestedParts = expectedVersion.split(".");
  for (let releaseXML of versionLettersXML) {
    if (!("attributes" in releaseXML)) {
      continue;
    }
    const releaseVersion = releaseXML.attributes.version;
    const releaseParts = releaseVersion.split(".");
    let matched = true;
    for (let i = 0; i < requestedParts.length; i++) {
      if (requestedParts[i] != releaseParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // this assumes that the releases are in order from newest to oldest
      bestMatch = releaseVersion;
      break;
    }
  }
  if (bestMatch == null) {
    throw new Error(`Apache Flex SDK version '${expectedVersion}' not found`);
  }
  return bestMatch;
}

function getAIRVersionBestMatch(/** @type string */ airVersion, /** @type {any[]} */ releases) {
  let bestMatch = null;
  const requestedParts = airVersion.split(".");
  for (let release of releases) {
    const releaseName = release.name;
    const releaseParts = releaseName.split(".");
    let matched = true;
    for (let i = 0; i < requestedParts.length; i++) {
      if (requestedParts[i] != releaseParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // this assumes that the releases are in order from newest to oldest
      bestMatch = releaseName;
      break;
    }
  }
  if (bestMatch == null) {
    throw new Error(`Adobe AIR SDK (HARMAN) version '${airVersion}' not found`);
  }
  return bestMatch;
}

function getFlexVersionLetterURL(versionLetterXML, mirrorPrefix) {
  let url = `${versionLetterXML.attributes.path}${versionLetterXML.attributes.file}`;
  if (!/^https?:\/\//.test(url)) {
    url = `${mirrorPrefix}/${url}`;
  }
  if (process.platform.startsWith("darwin")) {
    url += ".tar.gz";
  } else if (process.platform.startsWith("win")) {
    url += ".zip";
  } else {
    throw new Error(
      `Apache Flex SDK setup is not supported on platform: ${process.platform}`
    );
  }
  return url;
}

async function setupApacheFlex() {
  try {
    const acceptAIRLicense = core.getInput("accept-air-license", { required: true });
    if (!acceptAIRLicense) {
      throw new Error(
        "Parameter `accept-air-license` must be true to accept the Adobe AIR SDK License Agreement. Find it here: https://airsdk.harman.com/assets/pdfs/HARMAN%20AIR%20SDK%20License%20Agreement.pdf"
      );
    }
    const licenseFile = core.getInput("air-license-base64", { required: false });
    if (licenseFile) {
      const licenseBuffer = Buffer.from(licenseFile, "base64");
      const licensePath = path.join(os.homedir(), ".airsdk", "adt.lic");
      fs.mkdirSync(path.dirname(licensePath), { recursive: true });
      fs.writeFileSync(licensePath, licenseBuffer);
    }

    let flexVersion = core.getInput("flex-version", { required: true });
    const sdkConfigXML = await loadSDKConfig();
    const mirrorURLPrefix = await getMirrorURLPrefix(sdkConfigXML);
    const apacheFlexXML = getFlexSDKProducts(sdkConfigXML);
    flexVersion = getFlexVersionBestMatch(flexVersion, apacheFlexXML);

    console.log("Apache Flex SDK version: " + flexVersion);

    const flexHome = await downloadFlexSDK(flexVersion, mirrorURLPrefix);

    const airVersion = core.getInput("air-version", { required: true });
    const parsedMajorVersion = parseInt(airVersion.split(".")[0], 10);
    if (parsedMajorVersion <= 32) {
      // try to set up an old Adobe version of the AIR SDK
      setupApacheFlexWithAdobeAIR(airVersion, flexHome);
      return;
    }
    await setupApacheFlexWithHarmanAIR(airVersion, flexHome);
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function downloadFlexSDK(/** @type string */ flexVersion, /** @type string */ mirrorURLPrefix) {
  const flexDownloadURL = getFlexVersionLetterURL(
    flexVersion,
    mirrorURLPrefix
  );

  const flexDownloadFileName = path.basename(
    new URL(flexDownloadURL).pathname
  );
  const downloadedPath = await toolCache.downloadTool(
    flexDownloadURL,
    flexDownloadFileName
  );

  const installLocation = process.platform.startsWith("win")
    ? "c:\\ApacheFlexSDK"
    : "/usr/local/bin/ApacheFlexSDK";
  fs.mkdirSync(installLocation);

  if (process.platform.startsWith("darwin")) {
    await toolCache.extractTar(downloadedPath, installLocation);
  } else if (process.platform.startsWith("win")) {
    await toolCache.extractZip(downloadedPath, installLocation);
  }

  let flexHome = installLocation;
  if (process.platform.startsWith("darwin")) {
    const baseFileName = flexDownloadFileName.substr(
      0,
      flexDownloadFileName.length - 7 //.tar.gz
    );
    flexHome = path.resolve(installLocation, baseFileName);
  }
  core.addPath(path.resolve(flexHome, "bin"));
  core.exportVariable("FLEX_HOME", flexHome);
  return flexHome;
}

async function setupApacheFlexWithHarmanAIR(/** @type string */ airVersion, /** @type string */ flexHome) {
  throw new Error("Adobe AIR by HARMAN not yet supported");
}

function setupApacheFlexWithAdobeAIR(/** @type string */ airVersion, /** @type string */ flexHome) {
  if (airVersion == "32") {
    airVersion += ".0";
  }
  if (airVersion != "32.0") {
    throw new Error(
      `Expected Adobe AIR major version 32 or newer. Received version: ${airVersion}`
    );
  }

  child_process.execSync(
    "ant -f installer.xml -Dflash.sdk.version=32.0 -Dair.sdk.version=32.0 -Dinstaller=true -Ddo.flash.install=1 -Ddo.air.install=1 -Ddo.swfobject.install=1 -Ddo.fontswf.install=1 -Ddo.osmf.install=1 -Ddo.ofl.install=1",
    {
      cwd: flexHome,
      stdio: "inherit",
    }
  );
}

setupApacheFlex();
