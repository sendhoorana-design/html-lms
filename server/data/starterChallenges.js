// Starter challenge bank built from the Web Essentials lab manual (Units 1-5). Loaded on demand
// by the main admin ("Load starter challenges"); safe to load again — existing titles are skipped,
// so nothing is duplicated or overwritten.
module.exports = require('./part1').list.concat(require('./part2'), require('./part3'));
