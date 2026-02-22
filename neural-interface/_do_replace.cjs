const fs = require("fs");
const wizCode = fs.readFileSync("J:/Sites/Apps/Synabun/neural-interface/_wizard.txt", "utf8");
const filePath = "J:/Sites/Apps/Synabun/neural-interface/public/shared/ui-settings.js";
const content = fs.readFileSync(filePath, "utf8");
const placeholder = "  // placeholder — add collection wizard next";
const idx = content.indexOf(placeholder);
if (idx === -1) { console.error("Placeholder not found!"); process.exit(1); }
const newContent = content.replace(placeholder, wizCode);
fs.writeFileSync(filePath, newContent, "utf8");
console.log("SUCCESS: Replaced placeholder.");
console.log("Lines before:", content.split("
").length);
console.log("Lines after:", newContent.split("
").length);