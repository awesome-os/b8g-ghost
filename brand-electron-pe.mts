/**
 * @file brand-electron-pe.mts
 * @description Pure-JS PE resource brander (zero Wine / zero Windows deps) for `electron.exe`.
 * Replaces the default Electron atom icon and "Electron" Task Manager FileDescription with
 * Awesome-OS's Lumi White Dragon `.ico` and "Sectium Runtime" using `resedit`.
 *
 * Usage: node brand-electron-pe.mts <path-to-electron.exe> <path-to-lumi.ico> [description]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ResEdit = require('resedit') as typeof import('resedit');

const [, , exePath, icoPath, description = 'Sectium Runtime'] = process.argv;
if (!exePath || !icoPath) {
  console.error('Usage: node brand-electron-pe.mts <electron.exe> <lumi.ico> [description]');
  process.exit(1);
}

const exeData = readFileSync(exePath);
const exe = ResEdit.NtExecutable.from(exeData, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

// 1. Replace primary icon group (ID 1) with Lumi White Dragon .ico
const iconFile = ResEdit.Data.IconFile.from(readFileSync(icoPath));
const existingGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const primaryGroupId = existingGroups.length > 0 ? existingGroups[0].id : 1;
const primaryLang = existingGroups.length > 0 ? existingGroups[0].lang : 1033;

ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  primaryGroupId,
  primaryLang,
  iconFile.icons.map((item) => item.data),
);

// 2. Patch VS_VERSION_INFO FileDescription / ProductName -> "Sectium Runtime"
const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (viList.length > 0) {
  const vi = viList[0];
  const langs = vi.getAllLanguagesForStringValues();
  const targetLang = langs.length > 0 ? langs[0] : { lang: 1033, codepage: 1200 };
  vi.setStringValues(targetLang, {
    FileDescription: description,
    ProductName: `Awesome-OS ${description}`,
    CompanyName: 'Awesome-OS',
    InternalName: 'sectium-runtime',
    OriginalFilename: 'sectium-runtime.exe',
  });
  vi.outputToResourceEntries(res.entries);
}

res.outputResource(exe);
const newBinary = Buffer.from(exe.generate());
writeFileSync(exePath, newBinary);
console.log(`[brand-electron-pe] Branded ${exePath} -> "${description}" + Lumi icon (${newBinary.byteLength} B)`);
