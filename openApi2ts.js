const fs = require("fs");
const axios = require("axios");
const prettier = require("prettier");
require("dotenv").config();

let jsonContent;
const ax = axios.create({
  baseURL: "https://stedi.com/x12/",
  cookie: process.env.STEDI_COOKIE,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
});

async function getCodes(elementId) {
  const res = await ax.get(`/element/${elementId}`);
  const resData = res.data
    .split('<script id="__NEXT_DATA__" type="application/json">')[1]
    .split("</script>")[0];
  const codes = JSON.parse(resData).props.pageProps.elt.codes;
  return codes;
}

async function getSectionInformation(section) {
  try {
    const res = await ax.get(`/segment/${section}`);
    const resData = res.data
      .split('<script id="__NEXT_DATA__" type="application/json">')[1]
      .split("</script>")[0];
    const segmentInfo = JSON.parse(resData).props.pageProps.seg;
    const elements = segmentInfo.elements.map(async (element) => {
      if (element.codeCount > 0) {
        const codes = await getCodes(element.data_element_number);
        return { ...element, codes };
      }
      return element;
    });
    segmentInfo.elements = await Promise.all(elements);
    return segmentInfo;
  } catch (e) {
    console.log("could not get segment info for ", section);
    return;
  }
}

function convertToTypeScript(TSObject, name, type, usedSegments) {
  usedSegments = usedSegments ?? new Set();
  const TSObjectKeys = Object.keys(TSObject.properties);
  const isRequired = TSObject.required || [];
  const TSObjectProperties = TSObjectKeys.map((key) => {
    const compoutedType = convertPropertyToType(
      TSObject.properties[key],
      usedSegments,
    );
    return `${type === "class" ? "public " : ""}${key}${isRequired.includes(key) ? "" : "?"}:${compoutedType}`;
  });
  const TSObjectString = TSObjectProperties.join(";\n");

  if (type === "class") {
    const imports = Array.from(usedSegments)
      .map((segment) => `import {${segment}} from './segments/${segment}';`)
      .join("\n");
    return `${imports} \n\nexport class ${name} {\n${TSObjectString}\n}`;
  }
  if (type === "interface") {
    return `export interface ${name} {\n${TSObjectString}\n}`;
  }
  return `{\n${TSObjectString}\n}`;
}

const codeObjects = [];
const doneCodes = new Set();

const illegalMap = {
  "/": " or ",
  "(": "",
  ")": "_",
  __: "_",
};
function makeLegal(str) {
  return Object.entries(illegalMap)
    .reduce((acc, [key, value]) => {
      return acc.replaceAll(key, value);
    }, str)
    .split("")
    .filter((char) => /[a-zA-Z0-9_ ]/.test(char))
    .join("");
}
function makeScreamingSnakeCase(str) {
  str = makeLegal(str);
  return str.replaceAll(/\s/g, "_").replaceAll("__", "_").toUpperCase();
}

function makePascalCase(str) {
  str = makeLegal(str);
  return (
    str[0].toUpperCase() +
    str.replaceAll(/\s/g, "").replaceAll("_", "").slice(1)
  );
}

async function handleSection(TSObject, name) {
  const TSObjectKeys = Object.keys(TSObject.properties);
  const isRequired = TSObject.required || [];
  const segInfo = await getSectionInformation(name);
  const elementBySequence = segInfo?.elements?.reduce((acc, element) => {
    acc[element.sequence] = element;
    return acc;
  }, {});
  const segmentDescription = segInfo
    ? `/**
* @name ${segInfo.segment_name}
* @description This Segment is used ${segInfo.purpose}
**/ `
    : "";
  const usedCodes = new Set();
  const TSObjectProperties = await Promise.all(
    TSObjectKeys.map((key) => {
      const sequenceKey = key.split("_").pop();
      const element = elementBySequence?.[sequenceKey];
      const noteLine = element?.note ? `\n* NOTE: ${element.note}` : "";
      const descriptionComment = element
        ? `/**
* @name ${element.data_element_name}
* @description ${element.definition}
* max length: ${element.maximum_length ?? "N/A"}
* min length: ${element.minimum_length ?? "N/A"}
* element Code: ${element.data_element_number}${noteLine}
**/ `
        : "";
      if (element?.codeCount > 0) {
        const codeObjName = makeScreamingSnakeCase(element.data_element_name);
        const codeObjType = makePascalCase(element.data_element_name);
        usedCodes.add(codeObjType);
        if (doneCodes.has(codeObjName)) {
          return `${descriptionComment}\n${key}${isRequired.includes(key) ? "" : "?"}:${codeObjType}`;
        }
        doneCodes.add(codeObjName);
        codeObj = element.codes.reduce((acc, code) => {
          acc[code.content] = code.code_value;
          return acc;
        }, {});
        codeObjects.push({
          name: codeObjType,
          value: `export const ${codeObjName} = ${JSON.stringify(codeObj, null, 2)} as const;\n export type ${codeObjType} = typeof ${codeObjName}[keyof typeof ${codeObjName}]`,
        });
        return `${descriptionComment}\n${key}${isRequired.includes(key) ? "" : "?"}:${codeObjType}`;
      }
      return `${descriptionComment}\n${key}${isRequired.includes(key) ? "" : "?"}:${convertPropertyToType(TSObject.properties[key])}`;
    }),
  );
  const imports = Array.from(usedCodes)
    .map((code) => `import {${code}} from '../constants/${code}';`)
    .join("\n");
  const TSObjectString = TSObjectProperties.join(";\n\n");
  return `${imports} \n\n${segmentDescription}\nexport class ${name} {\n${TSObjectString}\n}`;
}

function convertPropertyToType(property, usedSegmentId) {
  if (property.type === "object") {
    if (property.hasOwnProperty("x-openedi-segment-id")) {
      if (usedSegmentId) {
        usedSegmentId.add(property["x-openedi-segment-id"]);
      }
      return property["x-openedi-segment-id"];
    }
    return convertToTypeScript(property, null, null, usedSegmentId);
  } else if (property.type === "array") {
    return `${convertPropertyToType(property.items, usedSegmentId)}[]`;
  } else if (property.hasOwnProperty("$ref")) {
    const ref = property["$ref"];
    const refKey = ref.split("/").pop();
    return convertPropertyToType(
      jsonContent.components.schemas[refKey],
      usedSegmentId,
    );
  }
  return property.type;
}

const doneSegments = new Set();

async function createAllSchemas() {
  const TSObjectKeys = Object.entries(jsonContent.components.schemas);
  const segments = [];
  const TSObjectProperties = await Promise.all(
    TSObjectKeys.map(async ([key, value]) => {
      if (value.hasOwnProperty("x-openedi-segment-id")) {
        if (!doneSegments.has(value["x-openedi-segment-id"])) {
          const name = value["x-openedi-segment-id"];
          doneSegments.add(name);
          const segment = await handleSection(value, name);
          segments.push({ name, value: segment });
        }
        return;
      }
      if (value.hasOwnProperty("x-openedi-message-id")) {
        const name = "EDI" + value["x-openedi-message-id"];
        return { name, value: convertToTypeScript(value, name, "class") };
      }
    }),
  );
  const prettierConfig = {
    parser: "typescript",
    singleQuote: true,
    trailingComma: "all",
    bracketSpacing: true,
    arrowParens: "always",
    endOfLine: "lf",
  };
  await Promise.all([
    segments.map(async (segment) =>
      fs.writeFileSync(
        `./output/segments/${segment.name}.ts`,
        await prettier.format(segment.value, prettierConfig),
      ),
    ),
    codeObjects.map(async (code) =>
      fs.writeFileSync(
        `./output/constants/${code.name}.ts`,
        await prettier.format(code.value, prettierConfig),
      ),
    ),
    TSObjectProperties.filter(Boolean).map(async (TSObject) => {
      if (TSObject) {
        fs.writeFileSync(
          `./output/${TSObject.name}.ts`,
          await prettier.format(TSObject.value, prettierConfig),
        );
      }
    }),
  ]);
}

async function main() {
  const inputFiles = fs.readdirSync("./inputs");

  if (!inputFiles.length) {
    console.error("You need to have Input schemas in inputs folder");
  }

  for (const file of inputFiles) {
    console.log(`Doing ... ${file}`);
    const fileContent = fs.readFileSync(`./inputs/${file}`, "utf8");
    jsonContent = JSON.parse(fileContent);
    await createAllSchemas();
    console.log(`${file} Done!`);
  }
}
main().then(() => console.log("All Done!"));
