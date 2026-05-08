import { createRequire as __cjsCreateRequire } from "node:module"; const require = __cjsCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/postgres-array@2.0.0/node_modules/postgres-array/index.js
var require_postgres_array = __commonJS({
  "node_modules/.pnpm/postgres-array@2.0.0/node_modules/postgres-array/index.js"(exports) {
    "use strict";
    exports.parse = function(source, transform) {
      return new ArrayParser(source, transform).parse();
    };
    var ArrayParser = class _ArrayParser {
      constructor(source, transform) {
        this.source = source;
        this.transform = transform || identity;
        this.position = 0;
        this.entries = [];
        this.recorded = [];
        this.dimension = 0;
      }
      isEof() {
        return this.position >= this.source.length;
      }
      nextCharacter() {
        var character = this.source[this.position++];
        if (character === "\\") {
          return {
            value: this.source[this.position++],
            escaped: true
          };
        }
        return {
          value: character,
          escaped: false
        };
      }
      record(character) {
        this.recorded.push(character);
      }
      newEntry(includeEmpty) {
        var entry;
        if (this.recorded.length > 0 || includeEmpty) {
          entry = this.recorded.join("");
          if (entry === "NULL" && !includeEmpty) {
            entry = null;
          }
          if (entry !== null) entry = this.transform(entry);
          this.entries.push(entry);
          this.recorded = [];
        }
      }
      consumeDimensions() {
        if (this.source[0] === "[") {
          while (!this.isEof()) {
            var char = this.nextCharacter();
            if (char.value === "=") break;
          }
        }
      }
      parse(nested) {
        var character, parser, quote;
        this.consumeDimensions();
        while (!this.isEof()) {
          character = this.nextCharacter();
          if (character.value === "{" && !quote) {
            this.dimension++;
            if (this.dimension > 1) {
              parser = new _ArrayParser(this.source.substr(this.position - 1), this.transform);
              this.entries.push(parser.parse(true));
              this.position += parser.position - 2;
            }
          } else if (character.value === "}" && !quote) {
            this.dimension--;
            if (!this.dimension) {
              this.newEntry();
              if (nested) return this.entries;
            }
          } else if (character.value === '"' && !character.escaped) {
            if (quote) this.newEntry(true);
            quote = !quote;
          } else if (character.value === "," && !quote) {
            this.newEntry();
          } else {
            this.record(character.value);
          }
        }
        if (this.dimension !== 0) {
          throw new Error("array dimension not balanced");
        }
        return this.entries;
      }
    };
    function identity(value) {
      return value;
    }
  }
});

// node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/arrayParser.js
var require_arrayParser = __commonJS({
  "node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/arrayParser.js"(exports, module) {
    var array = require_postgres_array();
    module.exports = {
      create: function(source, transform) {
        return {
          parse: function() {
            return array.parse(source, transform);
          }
        };
      }
    };
  }
});

// node_modules/.pnpm/postgres-date@1.0.7/node_modules/postgres-date/index.js
var require_postgres_date = __commonJS({
  "node_modules/.pnpm/postgres-date@1.0.7/node_modules/postgres-date/index.js"(exports, module) {
    "use strict";
    var DATE_TIME = /(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?.*?( BC)?$/;
    var DATE = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/;
    var TIME_ZONE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
    var INFINITY = /^-?infinity$/;
    module.exports = function parseDate(isoDate) {
      if (INFINITY.test(isoDate)) {
        return Number(isoDate.replace("i", "I"));
      }
      var matches = DATE_TIME.exec(isoDate);
      if (!matches) {
        return getDate(isoDate) || null;
      }
      var isBC = !!matches[8];
      var year = parseInt(matches[1], 10);
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var hour = parseInt(matches[4], 10);
      var minute = parseInt(matches[5], 10);
      var second = parseInt(matches[6], 10);
      var ms = matches[7];
      ms = ms ? 1e3 * parseFloat(ms) : 0;
      var date;
      var offset = timeZoneOffset(isoDate);
      if (offset != null) {
        date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        if (is0To99(year)) {
          date.setUTCFullYear(year);
        }
        if (offset !== 0) {
          date.setTime(date.getTime() - offset);
        }
      } else {
        date = new Date(year, month, day, hour, minute, second, ms);
        if (is0To99(year)) {
          date.setFullYear(year);
        }
      }
      return date;
    };
    function getDate(isoDate) {
      var matches = DATE.exec(isoDate);
      if (!matches) {
        return;
      }
      var year = parseInt(matches[1], 10);
      var isBC = !!matches[4];
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var date = new Date(year, month, day);
      if (is0To99(year)) {
        date.setFullYear(year);
      }
      return date;
    }
    function timeZoneOffset(isoDate) {
      if (isoDate.endsWith("+00")) {
        return 0;
      }
      var zone = TIME_ZONE.exec(isoDate.split(" ")[1]);
      if (!zone) return;
      var type = zone[1];
      if (type === "Z") {
        return 0;
      }
      var sign = type === "-" ? -1 : 1;
      var offset = parseInt(zone[2], 10) * 3600 + parseInt(zone[3] || 0, 10) * 60 + parseInt(zone[4] || 0, 10);
      return offset * sign * 1e3;
    }
    function bcYearToNegativeYear(year) {
      return -(year - 1);
    }
    function is0To99(num) {
      return num >= 0 && num < 100;
    }
  }
});

// node_modules/.pnpm/xtend@4.0.2/node_modules/xtend/mutable.js
var require_mutable = __commonJS({
  "node_modules/.pnpm/xtend@4.0.2/node_modules/xtend/mutable.js"(exports, module) {
    module.exports = extend;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function extend(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var key in source) {
          if (hasOwnProperty.call(source, key)) {
            target[key] = source[key];
          }
        }
      }
      return target;
    }
  }
});

// node_modules/.pnpm/postgres-interval@1.2.0/node_modules/postgres-interval/index.js
var require_postgres_interval = __commonJS({
  "node_modules/.pnpm/postgres-interval@1.2.0/node_modules/postgres-interval/index.js"(exports, module) {
    "use strict";
    var extend = require_mutable();
    module.exports = PostgresInterval;
    function PostgresInterval(raw) {
      if (!(this instanceof PostgresInterval)) {
        return new PostgresInterval(raw);
      }
      extend(this, parse(raw));
    }
    var properties = ["seconds", "minutes", "hours", "days", "months", "years"];
    PostgresInterval.prototype.toPostgres = function() {
      var filtered = properties.filter(this.hasOwnProperty, this);
      if (this.milliseconds && filtered.indexOf("seconds") < 0) {
        filtered.push("seconds");
      }
      if (filtered.length === 0) return "0";
      return filtered.map(function(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/\.?0+$/, "");
        }
        return value + " " + property;
      }, this).join(" ");
    };
    var propertiesISOEquivalent = {
      years: "Y",
      months: "M",
      days: "D",
      hours: "H",
      minutes: "M",
      seconds: "S"
    };
    var dateProperties = ["years", "months", "days"];
    var timeProperties = ["hours", "minutes", "seconds"];
    PostgresInterval.prototype.toISOString = PostgresInterval.prototype.toISO = function() {
      var datePart = dateProperties.map(buildProperty, this).join("");
      var timePart = timeProperties.map(buildProperty, this).join("");
      return "P" + datePart + "T" + timePart;
      function buildProperty(property) {
        var value = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value = (value + this.milliseconds / 1e3).toFixed(6).replace(/0+$/, "");
        }
        return value + propertiesISOEquivalent[property];
      }
    };
    var NUMBER = "([+-]?\\d+)";
    var YEAR = NUMBER + "\\s+years?";
    var MONTH = NUMBER + "\\s+mons?";
    var DAY = NUMBER + "\\s+days?";
    var TIME = "([+-])?([\\d]*):(\\d\\d):(\\d\\d)\\.?(\\d{1,6})?";
    var INTERVAL = new RegExp([YEAR, MONTH, DAY, TIME].map(function(regexString) {
      return "(" + regexString + ")?";
    }).join("\\s*"));
    var positions = {
      years: 2,
      months: 4,
      days: 6,
      hours: 9,
      minutes: 10,
      seconds: 11,
      milliseconds: 12
    };
    var negatives = ["hours", "minutes", "seconds", "milliseconds"];
    function parseMilliseconds(fraction) {
      var microseconds = fraction + "000000".slice(fraction.length);
      return parseInt(microseconds, 10) / 1e3;
    }
    function parse(interval) {
      if (!interval) return {};
      var matches = INTERVAL.exec(interval);
      var isNegative = matches[8] === "-";
      return Object.keys(positions).reduce(function(parsed, property) {
        var position = positions[property];
        var value = matches[position];
        if (!value) return parsed;
        value = property === "milliseconds" ? parseMilliseconds(value) : parseInt(value, 10);
        if (!value) return parsed;
        if (isNegative && ~negatives.indexOf(property)) {
          value *= -1;
        }
        parsed[property] = value;
        return parsed;
      }, {});
    }
  }
});

// node_modules/.pnpm/postgres-bytea@1.0.1/node_modules/postgres-bytea/index.js
var require_postgres_bytea = __commonJS({
  "node_modules/.pnpm/postgres-bytea@1.0.1/node_modules/postgres-bytea/index.js"(exports, module) {
    "use strict";
    var bufferFrom = Buffer.from || Buffer;
    module.exports = function parseBytea(input) {
      if (/^\\x/.test(input)) {
        return bufferFrom(input.substr(2), "hex");
      }
      var output = "";
      var i = 0;
      while (i < input.length) {
        if (input[i] !== "\\") {
          output += input[i];
          ++i;
        } else {
          if (/[0-7]{3}/.test(input.substr(i + 1, 3))) {
            output += String.fromCharCode(parseInt(input.substr(i + 1, 3), 8));
            i += 4;
          } else {
            var backslashes = 1;
            while (i + backslashes < input.length && input[i + backslashes] === "\\") {
              backslashes++;
            }
            for (var k = 0; k < Math.floor(backslashes / 2); ++k) {
              output += "\\";
            }
            i += Math.floor(backslashes / 2) * 2;
          }
        }
      }
      return bufferFrom(output, "binary");
    };
  }
});

// node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/textParsers.js
var require_textParsers = __commonJS({
  "node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/textParsers.js"(exports, module) {
    var array = require_postgres_array();
    var arrayParser = require_arrayParser();
    var parseDate = require_postgres_date();
    var parseInterval = require_postgres_interval();
    var parseByteA = require_postgres_bytea();
    function allowNull(fn) {
      return function nullAllowed(value) {
        if (value === null) return value;
        return fn(value);
      };
    }
    function parseBool(value) {
      if (value === null) return value;
      return value === "TRUE" || value === "t" || value === "true" || value === "y" || value === "yes" || value === "on" || value === "1";
    }
    function parseBoolArray(value) {
      if (!value) return null;
      return array.parse(value, parseBool);
    }
    function parseBaseTenInt(string) {
      return parseInt(string, 10);
    }
    function parseIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(parseBaseTenInt));
    }
    function parseBigIntegerArray(value) {
      if (!value) return null;
      return array.parse(value, allowNull(function(entry) {
        return parseBigInteger(entry).trim();
      }));
    }
    var parsePointArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parsePoint(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseFloatArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseFloat(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseStringArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value);
      return p.parse();
    };
    var parseDateArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseDate(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseIntervalArray = function(value) {
      if (!value) {
        return null;
      }
      var p = arrayParser.create(value, function(entry) {
        if (entry !== null) {
          entry = parseInterval(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseByteAArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(parseByteA));
    };
    var parseInteger = function(value) {
      return parseInt(value, 10);
    };
    var parseBigInteger = function(value) {
      var valStr = String(value);
      if (/^\d+$/.test(valStr)) {
        return valStr;
      }
      return value;
    };
    var parseJsonArray = function(value) {
      if (!value) {
        return null;
      }
      return array.parse(value, allowNull(JSON.parse));
    };
    var parsePoint = function(value) {
      if (value[0] !== "(") {
        return null;
      }
      value = value.substring(1, value.length - 1).split(",");
      return {
        x: parseFloat(value[0]),
        y: parseFloat(value[1])
      };
    };
    var parseCircle = function(value) {
      if (value[0] !== "<" && value[1] !== "(") {
        return null;
      }
      var point = "(";
      var radius = "";
      var pointParsed = false;
      for (var i = 2; i < value.length - 1; i++) {
        if (!pointParsed) {
          point += value[i];
        }
        if (value[i] === ")") {
          pointParsed = true;
          continue;
        } else if (!pointParsed) {
          continue;
        }
        if (value[i] === ",") {
          continue;
        }
        radius += value[i];
      }
      var result = parsePoint(point);
      result.radius = parseFloat(radius);
      return result;
    };
    var init = function(register) {
      register(20, parseBigInteger);
      register(21, parseInteger);
      register(23, parseInteger);
      register(26, parseInteger);
      register(700, parseFloat);
      register(701, parseFloat);
      register(16, parseBool);
      register(1082, parseDate);
      register(1114, parseDate);
      register(1184, parseDate);
      register(600, parsePoint);
      register(651, parseStringArray);
      register(718, parseCircle);
      register(1e3, parseBoolArray);
      register(1001, parseByteAArray);
      register(1005, parseIntegerArray);
      register(1007, parseIntegerArray);
      register(1028, parseIntegerArray);
      register(1016, parseBigIntegerArray);
      register(1017, parsePointArray);
      register(1021, parseFloatArray);
      register(1022, parseFloatArray);
      register(1231, parseFloatArray);
      register(1014, parseStringArray);
      register(1015, parseStringArray);
      register(1008, parseStringArray);
      register(1009, parseStringArray);
      register(1040, parseStringArray);
      register(1041, parseStringArray);
      register(1115, parseDateArray);
      register(1182, parseDateArray);
      register(1185, parseDateArray);
      register(1186, parseInterval);
      register(1187, parseIntervalArray);
      register(17, parseByteA);
      register(114, JSON.parse.bind(JSON));
      register(3802, JSON.parse.bind(JSON));
      register(199, parseJsonArray);
      register(3807, parseJsonArray);
      register(3907, parseStringArray);
      register(2951, parseStringArray);
      register(791, parseStringArray);
      register(1183, parseStringArray);
      register(1270, parseStringArray);
    };
    module.exports = {
      init
    };
  }
});

// node_modules/.pnpm/pg-int8@1.0.1/node_modules/pg-int8/index.js
var require_pg_int8 = __commonJS({
  "node_modules/.pnpm/pg-int8@1.0.1/node_modules/pg-int8/index.js"(exports, module) {
    "use strict";
    var BASE = 1e6;
    function readInt8(buffer) {
      var high = buffer.readInt32BE(0);
      var low = buffer.readUInt32BE(4);
      var sign = "";
      if (high < 0) {
        high = ~high + (low === 0);
        low = ~low + 1 >>> 0;
        sign = "-";
      }
      var result = "";
      var carry;
      var t;
      var digits;
      var pad;
      var l;
      var i;
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign + digits + result;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result = pad + digits + result;
      }
      {
        carry = high % BASE;
        t = 4294967296 * carry + low;
        digits = "" + t % BASE;
        return sign + digits + result;
      }
    }
    module.exports = readInt8;
  }
});

// node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/binaryParsers.js
var require_binaryParsers = __commonJS({
  "node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/binaryParsers.js"(exports, module) {
    var parseInt64 = require_pg_int8();
    var parseBits = function(data, bits, offset, invert, callback) {
      offset = offset || 0;
      invert = invert || false;
      callback = callback || function(lastValue, newValue, bits2) {
        return lastValue * Math.pow(2, bits2) + newValue;
      };
      var offsetBytes = offset >> 3;
      var inv = function(value) {
        if (invert) {
          return ~value & 255;
        }
        return value;
      };
      var mask = 255;
      var firstBits = 8 - offset % 8;
      if (bits < firstBits) {
        mask = 255 << 8 - bits & 255;
        firstBits = bits;
      }
      if (offset) {
        mask = mask >> offset % 8;
      }
      var result = 0;
      if (offset % 8 + bits >= 8) {
        result = callback(0, inv(data[offsetBytes]) & mask, firstBits);
      }
      var bytes = bits + offset >> 3;
      for (var i = offsetBytes + 1; i < bytes; i++) {
        result = callback(result, inv(data[i]), 8);
      }
      var lastBits = (bits + offset) % 8;
      if (lastBits > 0) {
        result = callback(result, inv(data[bytes]) >> 8 - lastBits, lastBits);
      }
      return result;
    };
    var parseFloatFromBits = function(data, precisionBits, exponentBits) {
      var bias = Math.pow(2, exponentBits - 1) - 1;
      var sign = parseBits(data, 1);
      var exponent = parseBits(data, exponentBits, 1);
      if (exponent === 0) {
        return 0;
      }
      var precisionBitsCounter = 1;
      var parsePrecisionBits = function(lastValue, newValue, bits) {
        if (lastValue === 0) {
          lastValue = 1;
        }
        for (var i = 1; i <= bits; i++) {
          precisionBitsCounter /= 2;
          if ((newValue & 1 << bits - i) > 0) {
            lastValue += precisionBitsCounter;
          }
        }
        return lastValue;
      };
      var mantissa = parseBits(data, precisionBits, exponentBits + 1, false, parsePrecisionBits);
      if (exponent == Math.pow(2, exponentBits + 1) - 1) {
        if (mantissa === 0) {
          return sign === 0 ? Infinity : -Infinity;
        }
        return NaN;
      }
      return (sign === 0 ? 1 : -1) * Math.pow(2, exponent - bias) * mantissa;
    };
    var parseInt16 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 15, 1, true) + 1);
      }
      return parseBits(value, 15, 1);
    };
    var parseInt32 = function(value) {
      if (parseBits(value, 1) == 1) {
        return -1 * (parseBits(value, 31, 1, true) + 1);
      }
      return parseBits(value, 31, 1);
    };
    var parseFloat32 = function(value) {
      return parseFloatFromBits(value, 23, 8);
    };
    var parseFloat64 = function(value) {
      return parseFloatFromBits(value, 52, 11);
    };
    var parseNumeric = function(value) {
      var sign = parseBits(value, 16, 32);
      if (sign == 49152) {
        return NaN;
      }
      var weight = Math.pow(1e4, parseBits(value, 16, 16));
      var result = 0;
      var digits = [];
      var ndigits = parseBits(value, 16);
      for (var i = 0; i < ndigits; i++) {
        result += parseBits(value, 16, 64 + 16 * i) * weight;
        weight /= 1e4;
      }
      var scale = Math.pow(10, parseBits(value, 16, 48));
      return (sign === 0 ? 1 : -1) * Math.round(result * scale) / scale;
    };
    var parseDate = function(isUTC, value) {
      var sign = parseBits(value, 1);
      var rawValue = parseBits(value, 63, 1);
      var result = new Date((sign === 0 ? 1 : -1) * rawValue / 1e3 + 9466848e5);
      if (!isUTC) {
        result.setTime(result.getTime() + result.getTimezoneOffset() * 6e4);
      }
      result.usec = rawValue % 1e3;
      result.getMicroSeconds = function() {
        return this.usec;
      };
      result.setMicroSeconds = function(value2) {
        this.usec = value2;
      };
      result.getUTCMicroSeconds = function() {
        return this.usec;
      };
      return result;
    };
    var parseArray = function(value) {
      var dim = parseBits(value, 32);
      var flags = parseBits(value, 32, 32);
      var elementType = parseBits(value, 32, 64);
      var offset = 96;
      var dims = [];
      for (var i = 0; i < dim; i++) {
        dims[i] = parseBits(value, 32, offset);
        offset += 32;
        offset += 32;
      }
      var parseElement = function(elementType2) {
        var length = parseBits(value, 32, offset);
        offset += 32;
        if (length == 4294967295) {
          return null;
        }
        var result;
        if (elementType2 == 23 || elementType2 == 20) {
          result = parseBits(value, length * 8, offset);
          offset += length * 8;
          return result;
        } else if (elementType2 == 25) {
          result = value.toString(this.encoding, offset >> 3, (offset += length << 3) >> 3);
          return result;
        } else {
          console.log("ERROR: ElementType not implemented: " + elementType2);
        }
      };
      var parse = function(dimension, elementType2) {
        var array = [];
        var i2;
        if (dimension.length > 1) {
          var count = dimension.shift();
          for (i2 = 0; i2 < count; i2++) {
            array[i2] = parse(dimension, elementType2);
          }
          dimension.unshift(count);
        } else {
          for (i2 = 0; i2 < dimension[0]; i2++) {
            array[i2] = parseElement(elementType2);
          }
        }
        return array;
      };
      return parse(dims, elementType);
    };
    var parseText = function(value) {
      return value.toString("utf8");
    };
    var parseBool = function(value) {
      if (value === null) return null;
      return parseBits(value, 8) > 0;
    };
    var init = function(register) {
      register(20, parseInt64);
      register(21, parseInt16);
      register(23, parseInt32);
      register(26, parseInt32);
      register(1700, parseNumeric);
      register(700, parseFloat32);
      register(701, parseFloat64);
      register(16, parseBool);
      register(1114, parseDate.bind(null, false));
      register(1184, parseDate.bind(null, true));
      register(1e3, parseArray);
      register(1007, parseArray);
      register(1016, parseArray);
      register(1008, parseArray);
      register(1009, parseArray);
      register(25, parseText);
    };
    module.exports = {
      init
    };
  }
});

// node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/builtins.js
var require_builtins = __commonJS({
  "node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/lib/builtins.js"(exports, module) {
    module.exports = {
      BOOL: 16,
      BYTEA: 17,
      CHAR: 18,
      INT8: 20,
      INT2: 21,
      INT4: 23,
      REGPROC: 24,
      TEXT: 25,
      OID: 26,
      TID: 27,
      XID: 28,
      CID: 29,
      JSON: 114,
      XML: 142,
      PG_NODE_TREE: 194,
      SMGR: 210,
      PATH: 602,
      POLYGON: 604,
      CIDR: 650,
      FLOAT4: 700,
      FLOAT8: 701,
      ABSTIME: 702,
      RELTIME: 703,
      TINTERVAL: 704,
      CIRCLE: 718,
      MACADDR8: 774,
      MONEY: 790,
      MACADDR: 829,
      INET: 869,
      ACLITEM: 1033,
      BPCHAR: 1042,
      VARCHAR: 1043,
      DATE: 1082,
      TIME: 1083,
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      INTERVAL: 1186,
      TIMETZ: 1266,
      BIT: 1560,
      VARBIT: 1562,
      NUMERIC: 1700,
      REFCURSOR: 1790,
      REGPROCEDURE: 2202,
      REGOPER: 2203,
      REGOPERATOR: 2204,
      REGCLASS: 2205,
      REGTYPE: 2206,
      UUID: 2950,
      TXID_SNAPSHOT: 2970,
      PG_LSN: 3220,
      PG_NDISTINCT: 3361,
      PG_DEPENDENCIES: 3402,
      TSVECTOR: 3614,
      TSQUERY: 3615,
      GTSVECTOR: 3642,
      REGCONFIG: 3734,
      REGDICTIONARY: 3769,
      JSONB: 3802,
      REGNAMESPACE: 4089,
      REGROLE: 4096
    };
  }
});

// node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/index.js
var require_pg_types = __commonJS({
  "node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-types/index.js"(exports) {
    var textParsers = require_textParsers();
    var binaryParsers = require_binaryParsers();
    var arrayParser = require_arrayParser();
    var builtinTypes = require_builtins();
    exports.getTypeParser = getTypeParser;
    exports.setTypeParser = setTypeParser;
    exports.arrayParser = arrayParser;
    exports.builtins = builtinTypes;
    var typeParsers = {
      text: {},
      binary: {}
    };
    function noParse(val) {
      return String(val);
    }
    function getTypeParser(oid, format) {
      format = format || "text";
      if (!typeParsers[format]) {
        return noParse;
      }
      return typeParsers[format][oid] || noParse;
    }
    function setTypeParser(oid, format, parseFn) {
      if (typeof format == "function") {
        parseFn = format;
        format = "text";
      }
      typeParsers[format][oid] = parseFn;
    }
    textParsers.init(function(oid, converter) {
      typeParsers.text[oid] = converter;
    });
    binaryParsers.init(function(oid, converter) {
      typeParsers.binary[oid] = converter;
    });
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/defaults.js
var require_defaults = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/defaults.js"(exports, module) {
    "use strict";
    var user;
    try {
      user = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
    } catch {
    }
    module.exports = {
      // database host. defaults to localhost
      host: "localhost",
      // database user's name
      user,
      // name of database to connect
      database: void 0,
      // database user's password
      password: null,
      // a Postgres connection string to be used instead of setting individual connection items
      // NOTE:  Setting this value will cause it to override any other value (such as database or user) defined
      // in the defaults object.
      connectionString: void 0,
      // database port
      port: 5432,
      // number of rows to return at a time from a prepared statement's
      // portal. 0 will return all rows at once
      rows: 0,
      // binary result mode
      binary: false,
      // Connection pool options - see https://github.com/brianc/node-pg-pool
      // number of connections to use in connection pool
      // 0 will disable connection pooling
      max: 10,
      // max milliseconds a client can go unused before it is removed
      // from the pool and destroyed
      idleTimeoutMillis: 3e4,
      client_encoding: "",
      ssl: false,
      application_name: void 0,
      fallback_application_name: void 0,
      options: void 0,
      parseInputDatesAsUTC: false,
      // max milliseconds any query using this connection will execute for before timing out in error.
      // false=unlimited
      statement_timeout: false,
      // Abort any statement that waits longer than the specified duration in milliseconds while attempting to acquire a lock.
      // false=unlimited
      lock_timeout: false,
      // Terminate any session with an open transaction that has been idle for longer than the specified duration in milliseconds
      // false=unlimited
      idle_in_transaction_session_timeout: false,
      // max milliseconds to wait for query to complete (client side)
      query_timeout: false,
      connect_timeout: 0,
      keepalives: 1,
      keepalives_idle: 0
    };
    var pgTypes = require_pg_types();
    var parseBigInteger = pgTypes.getTypeParser(20, "text");
    var parseBigIntegerArray = pgTypes.getTypeParser(1016, "text");
    module.exports.__defineSetter__("parseInt8", function(val) {
      pgTypes.setTypeParser(20, "text", val ? pgTypes.getTypeParser(23, "text") : parseBigInteger);
      pgTypes.setTypeParser(1016, "text", val ? pgTypes.getTypeParser(1007, "text") : parseBigIntegerArray);
    });
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/utils.js
var require_utils = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/utils.js"(exports, module) {
    "use strict";
    var defaults2 = require_defaults();
    var util = __require("util");
    var { isDate } = util.types || util;
    function escapeElement(elementRepresentation) {
      const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return '"' + escaped + '"';
    }
    function arrayString(val) {
      let result = "{";
      for (let i = 0; i < val.length; i++) {
        if (i > 0) {
          result = result + ",";
        }
        if (val[i] === null || typeof val[i] === "undefined") {
          result = result + "NULL";
        } else if (Array.isArray(val[i])) {
          result = result + arrayString(val[i]);
        } else if (ArrayBuffer.isView(val[i])) {
          let item = val[i];
          if (!(item instanceof Buffer)) {
            const buf = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
            if (buf.length === item.byteLength) {
              item = buf;
            } else {
              item = buf.slice(item.byteOffset, item.byteOffset + item.byteLength);
            }
          }
          result += "\\\\x" + item.toString("hex");
        } else {
          result += escapeElement(prepareValue(val[i]));
        }
      }
      result = result + "}";
      return result;
    }
    var prepareValue = function(val, seen) {
      if (val == null) {
        return null;
      }
      if (typeof val === "object") {
        if (val instanceof Buffer) {
          return val;
        }
        if (ArrayBuffer.isView(val)) {
          const buf = Buffer.from(val.buffer, val.byteOffset, val.byteLength);
          if (buf.length === val.byteLength) {
            return buf;
          }
          return buf.slice(val.byteOffset, val.byteOffset + val.byteLength);
        }
        if (isDate(val)) {
          if (defaults2.parseInputDatesAsUTC) {
            return dateToStringUTC(val);
          } else {
            return dateToString(val);
          }
        }
        if (Array.isArray(val)) {
          return arrayString(val);
        }
        return prepareObject(val, seen);
      }
      return val.toString();
    };
    function prepareObject(val, seen) {
      if (val && typeof val.toPostgres === "function") {
        seen = seen || [];
        if (seen.indexOf(val) !== -1) {
          throw new Error('circular reference detected while preparing "' + val + '" for query');
        }
        seen.push(val);
        return prepareValue(val.toPostgres(prepareValue), seen);
      }
      return JSON.stringify(val);
    }
    function dateToString(date) {
      let offset = -date.getTimezoneOffset();
      let year = date.getFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0") + "." + String(date.getMilliseconds()).padStart(3, "0");
      if (offset < 0) {
        ret += "-";
        offset *= -1;
      } else {
        ret += "+";
      }
      ret += String(Math.floor(offset / 60)).padStart(2, "0") + ":" + String(offset % 60).padStart(2, "0");
      if (isBCYear) ret += " BC";
      return ret;
    }
    function dateToStringUTC(date) {
      let year = date.getUTCFullYear();
      const isBCYear = year < 1;
      if (isBCYear) year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0") + "T" + String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0") + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
      ret += "+00:00";
      if (isBCYear) ret += " BC";
      return ret;
    }
    function normalizeQueryConfig(config, values, callback) {
      config = typeof config === "string" ? { text: config } : config;
      if (values) {
        if (typeof values === "function") {
          config.callback = values;
        } else {
          config.values = values;
        }
      }
      if (callback) {
        config.callback = callback;
      }
      return config;
    }
    var escapeIdentifier2 = function(str) {
      return '"' + str.replace(/"/g, '""') + '"';
    };
    var escapeLiteral2 = function(str) {
      let hasBackslash = false;
      let escaped = "'";
      if (str == null) {
        return "''";
      }
      if (typeof str !== "string") {
        return "''";
      }
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === "'") {
          escaped += c + c;
        } else if (c === "\\") {
          escaped += c + c;
          hasBackslash = true;
        } else {
          escaped += c;
        }
      }
      escaped += "'";
      if (hasBackslash === true) {
        escaped = " E" + escaped;
      }
      return escaped;
    };
    module.exports = {
      prepareValue: function prepareValueWrapper(value) {
        return prepareValue(value);
      },
      normalizeQueryConfig,
      escapeIdentifier: escapeIdentifier2,
      escapeLiteral: escapeLiteral2
    };
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/utils-legacy.js
var require_utils_legacy = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/utils-legacy.js"(exports, module) {
    "use strict";
    var nodeCrypto = __require("crypto");
    function md5(string) {
      return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
    }
    function postgresMd5PasswordHash(user, password, salt) {
      const inner = md5(password + user);
      const outer = md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    function sha256(text) {
      return nodeCrypto.createHash("sha256").update(text).digest();
    }
    function hashByName(hashName, text) {
      hashName = hashName.replace(/(\D)-/, "$1");
      return nodeCrypto.createHash(hashName).update(text).digest();
    }
    function hmacSha256(key, msg) {
      return nodeCrypto.createHmac("sha256", key).update(msg).digest();
    }
    async function deriveKey(password, salt, iterations) {
      return nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    }
    module.exports = {
      postgresMd5PasswordHash,
      randomBytes: nodeCrypto.randomBytes,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/utils-webcrypto.js
var require_utils_webcrypto = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/utils-webcrypto.js"(exports, module) {
    var nodeCrypto = __require("crypto");
    module.exports = {
      postgresMd5PasswordHash,
      randomBytes: randomBytes2,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
    var webCrypto = nodeCrypto.webcrypto || globalThis.crypto;
    var subtleCrypto = webCrypto.subtle;
    var textEncoder = new TextEncoder();
    function randomBytes2(length) {
      return webCrypto.getRandomValues(Buffer.alloc(length));
    }
    async function md5(string) {
      try {
        return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
      } catch (e) {
        const data = typeof string === "string" ? textEncoder.encode(string) : string;
        const hash = await subtleCrypto.digest("MD5", data);
        return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    }
    async function postgresMd5PasswordHash(user, password, salt) {
      const inner = await md5(password + user);
      const outer = await md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    async function sha256(text) {
      return await subtleCrypto.digest("SHA-256", text);
    }
    async function hashByName(hashName, text) {
      return await subtleCrypto.digest(hashName, text);
    }
    async function hmacSha256(keyBuffer, msg) {
      const key = await subtleCrypto.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return await subtleCrypto.sign("HMAC", key, textEncoder.encode(msg));
    }
    async function deriveKey(password, salt, iterations) {
      const key = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations };
      return await subtleCrypto.deriveBits(params, key, 32 * 8, ["deriveBits"]);
    }
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/utils.js
var require_utils2 = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/utils.js"(exports, module) {
    "use strict";
    var useLegacyCrypto = parseInt(process.versions && process.versions.node && process.versions.node.split(".")[0]) < 15;
    if (useLegacyCrypto) {
      module.exports = require_utils_legacy();
    } else {
      module.exports = require_utils_webcrypto();
    }
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/cert-signatures.js
var require_cert_signatures = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/cert-signatures.js"(exports, module) {
    function x509Error(msg, cert) {
      return new Error("SASL channel binding: " + msg + " when parsing public certificate " + cert.toString("base64"));
    }
    function readASN1Length(data, index) {
      let length = data[index++];
      if (length < 128) return { length, index };
      const lengthBytes = length & 127;
      if (lengthBytes > 4) throw x509Error("bad length", data);
      length = 0;
      for (let i = 0; i < lengthBytes; i++) {
        length = length << 8 | data[index++];
      }
      return { length, index };
    }
    function readASN1OID(data, index) {
      if (data[index++] !== 6) throw x509Error("non-OID data", data);
      const { length: OIDLength, index: indexAfterOIDLength } = readASN1Length(data, index);
      index = indexAfterOIDLength;
      const lastIndex = index + OIDLength;
      const byte1 = data[index++];
      let oid = (byte1 / 40 >> 0) + "." + byte1 % 40;
      while (index < lastIndex) {
        let value = 0;
        while (index < lastIndex) {
          const nextByte = data[index++];
          value = value << 7 | nextByte & 127;
          if (nextByte < 128) break;
        }
        oid += "." + value;
      }
      return { oid, index };
    }
    function expectASN1Seq(data, index) {
      if (data[index++] !== 48) throw x509Error("non-sequence data", data);
      return readASN1Length(data, index);
    }
    function signatureAlgorithmHashFromCertificate(data, index) {
      if (index === void 0) index = 0;
      index = expectASN1Seq(data, index).index;
      const { length: certInfoLength, index: indexAfterCertInfoLength } = expectASN1Seq(data, index);
      index = indexAfterCertInfoLength + certInfoLength;
      index = expectASN1Seq(data, index).index;
      const { oid, index: indexAfterOID } = readASN1OID(data, index);
      switch (oid) {
        // RSA
        case "1.2.840.113549.1.1.4":
          return "MD5";
        case "1.2.840.113549.1.1.5":
          return "SHA-1";
        case "1.2.840.113549.1.1.11":
          return "SHA-256";
        case "1.2.840.113549.1.1.12":
          return "SHA-384";
        case "1.2.840.113549.1.1.13":
          return "SHA-512";
        case "1.2.840.113549.1.1.14":
          return "SHA-224";
        case "1.2.840.113549.1.1.15":
          return "SHA512-224";
        case "1.2.840.113549.1.1.16":
          return "SHA512-256";
        // ECDSA
        case "1.2.840.10045.4.1":
          return "SHA-1";
        case "1.2.840.10045.4.3.1":
          return "SHA-224";
        case "1.2.840.10045.4.3.2":
          return "SHA-256";
        case "1.2.840.10045.4.3.3":
          return "SHA-384";
        case "1.2.840.10045.4.3.4":
          return "SHA-512";
        // RSASSA-PSS: hash is indicated separately
        case "1.2.840.113549.1.1.10": {
          index = indexAfterOID;
          index = expectASN1Seq(data, index).index;
          if (data[index++] !== 160) throw x509Error("non-tag data", data);
          index = readASN1Length(data, index).index;
          index = expectASN1Seq(data, index).index;
          const { oid: hashOID } = readASN1OID(data, index);
          switch (hashOID) {
            // standalone hash OIDs
            case "1.2.840.113549.2.5":
              return "MD5";
            case "1.3.14.3.2.26":
              return "SHA-1";
            case "2.16.840.1.101.3.4.2.1":
              return "SHA-256";
            case "2.16.840.1.101.3.4.2.2":
              return "SHA-384";
            case "2.16.840.1.101.3.4.2.3":
              return "SHA-512";
          }
          throw x509Error("unknown hash OID " + hashOID, data);
        }
        // Ed25519 -- see https: return//github.com/openssl/openssl/issues/15477
        case "1.3.101.110":
        case "1.3.101.112":
          return "SHA-512";
        // Ed448 -- still not in pg 17.2 (if supported, digest would be SHAKE256 x 64 bytes)
        case "1.3.101.111":
        case "1.3.101.113":
          throw x509Error("Ed448 certificate channel binding is not currently supported by Postgres");
      }
      throw x509Error("unknown OID " + oid, data);
    }
    module.exports = { signatureAlgorithmHashFromCertificate };
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/sasl.js
var require_sasl = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/crypto/sasl.js"(exports, module) {
    "use strict";
    var crypto2 = require_utils2();
    var { signatureAlgorithmHashFromCertificate } = require_cert_signatures();
    function startSession(mechanisms, stream) {
      const candidates = ["SCRAM-SHA-256"];
      if (stream) candidates.unshift("SCRAM-SHA-256-PLUS");
      const mechanism = candidates.find((candidate) => mechanisms.includes(candidate));
      if (!mechanism) {
        throw new Error("SASL: Only mechanism(s) " + candidates.join(" and ") + " are supported");
      }
      if (mechanism === "SCRAM-SHA-256-PLUS" && typeof stream.getPeerCertificate !== "function") {
        throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");
      }
      const clientNonce = crypto2.randomBytes(18).toString("base64");
      const gs2Header = mechanism === "SCRAM-SHA-256-PLUS" ? "p=tls-server-end-point" : stream ? "y" : "n";
      return {
        mechanism,
        clientNonce,
        response: gs2Header + ",,n=*,r=" + clientNonce,
        message: "SASLInitialResponse"
      };
    }
    async function continueSession(session, password, serverData, stream) {
      if (session.message !== "SASLInitialResponse") {
        throw new Error("SASL: Last message was not SASLInitialResponse");
      }
      if (typeof password !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
      }
      if (password === "") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");
      }
      const sv = parseServerFirstMessage(serverData);
      if (!sv.nonce.startsWith(session.clientNonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");
      } else if (sv.nonce.length === session.clientNonce.length) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short");
      }
      const clientFirstMessageBare = "n=*,r=" + session.clientNonce;
      const serverFirstMessage = "r=" + sv.nonce + ",s=" + sv.salt + ",i=" + sv.iteration;
      let channelBinding = stream ? "eSws" : "biws";
      if (session.mechanism === "SCRAM-SHA-256-PLUS") {
        const peerCert = stream.getPeerCertificate().raw;
        let hashName = signatureAlgorithmHashFromCertificate(peerCert);
        if (hashName === "MD5" || hashName === "SHA-1") hashName = "SHA-256";
        const certHash = await crypto2.hashByName(hashName, peerCert);
        const bindingData = Buffer.concat([Buffer.from("p=tls-server-end-point,,"), Buffer.from(certHash)]);
        channelBinding = bindingData.toString("base64");
      }
      const clientFinalMessageWithoutProof = "c=" + channelBinding + ",r=" + sv.nonce;
      const authMessage = clientFirstMessageBare + "," + serverFirstMessage + "," + clientFinalMessageWithoutProof;
      const saltBytes = Buffer.from(sv.salt, "base64");
      const saltedPassword = await crypto2.deriveKey(password, saltBytes, sv.iteration);
      const clientKey = await crypto2.hmacSha256(saltedPassword, "Client Key");
      const storedKey = await crypto2.sha256(clientKey);
      const clientSignature = await crypto2.hmacSha256(storedKey, authMessage);
      const clientProof = xorBuffers(Buffer.from(clientKey), Buffer.from(clientSignature)).toString("base64");
      const serverKey = await crypto2.hmacSha256(saltedPassword, "Server Key");
      const serverSignatureBytes = await crypto2.hmacSha256(serverKey, authMessage);
      session.message = "SASLResponse";
      session.serverSignature = Buffer.from(serverSignatureBytes).toString("base64");
      session.response = clientFinalMessageWithoutProof + ",p=" + clientProof;
    }
    function finalizeSession(session, serverData) {
      if (session.message !== "SASLResponse") {
        throw new Error("SASL: Last message was not SASLResponse");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");
      }
      const { serverSignature } = parseServerFinalMessage(serverData);
      if (serverSignature !== session.serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match");
      }
    }
    function isPrintableChars(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: text must be a string");
      }
      return text.split("").map((_, i) => text.charCodeAt(i)).every((c) => c >= 33 && c <= 43 || c >= 45 && c <= 126);
    }
    function isBase64(text) {
      return /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text);
    }
    function parseAttributePairs(text) {
      if (typeof text !== "string") {
        throw new TypeError("SASL: attribute pairs text must be a string");
      }
      return new Map(
        text.split(",").map((attrValue) => {
          if (!/^.=/.test(attrValue)) {
            throw new Error("SASL: Invalid attribute pair entry");
          }
          const name = attrValue[0];
          const value = attrValue.substring(2);
          return [name, value];
        })
      );
    }
    function parseServerFirstMessage(data) {
      const attrPairs = parseAttributePairs(data);
      const nonce = attrPairs.get("r");
      if (!nonce) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");
      } else if (!isPrintableChars(nonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters");
      }
      const salt = attrPairs.get("s");
      if (!salt) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");
      } else if (!isBase64(salt)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64");
      }
      const iterationText = attrPairs.get("i");
      if (!iterationText) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");
      } else if (!/^[1-9][0-9]*$/.test(iterationText)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count");
      }
      const iteration = parseInt(iterationText, 10);
      return {
        nonce,
        salt,
        iteration
      };
    }
    function parseServerFinalMessage(serverData) {
      const attrPairs = parseAttributePairs(serverData);
      const serverSignature = attrPairs.get("v");
      if (!serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");
      } else if (!isBase64(serverSignature)) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64");
      }
      return {
        serverSignature
      };
    }
    function xorBuffers(a, b) {
      if (!Buffer.isBuffer(a)) {
        throw new TypeError("first argument must be a Buffer");
      }
      if (!Buffer.isBuffer(b)) {
        throw new TypeError("second argument must be a Buffer");
      }
      if (a.length !== b.length) {
        throw new Error("Buffer lengths must match");
      }
      if (a.length === 0) {
        throw new Error("Buffers cannot be empty");
      }
      return Buffer.from(a.map((_, i) => a[i] ^ b[i]));
    }
    module.exports = {
      startSession,
      continueSession,
      finalizeSession
    };
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/type-overrides.js
var require_type_overrides = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/type-overrides.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    function TypeOverrides2(userTypes) {
      this._types = userTypes || types2;
      this.text = {};
      this.binary = {};
    }
    TypeOverrides2.prototype.getOverrides = function(format) {
      switch (format) {
        case "text":
          return this.text;
        case "binary":
          return this.binary;
        default:
          return {};
      }
    };
    TypeOverrides2.prototype.setTypeParser = function(oid, format, parseFn) {
      if (typeof format === "function") {
        parseFn = format;
        format = "text";
      }
      this.getOverrides(format)[oid] = parseFn;
    };
    TypeOverrides2.prototype.getTypeParser = function(oid, format) {
      format = format || "text";
      return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
    };
    module.exports = TypeOverrides2;
  }
});

// node_modules/.pnpm/pg-connection-string@2.12.0/node_modules/pg-connection-string/index.js
var require_pg_connection_string = __commonJS({
  "node_modules/.pnpm/pg-connection-string@2.12.0/node_modules/pg-connection-string/index.js"(exports, module) {
    "use strict";
    function parse(str, options = {}) {
      if (str.charAt(0) === "/") {
        const config2 = str.split(" ");
        return { host: config2[0], database: config2[1] };
      }
      const config = {};
      let result;
      let dummyHost = false;
      if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
        str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
      }
      try {
        try {
          result = new URL(str, "postgres://base");
        } catch (e) {
          result = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
          dummyHost = true;
        }
      } catch (err) {
        err.input && (err.input = "*****REDACTED*****");
        throw err;
      }
      for (const entry of result.searchParams.entries()) {
        config[entry[0]] = entry[1];
      }
      config.user = config.user || decodeURIComponent(result.username);
      config.password = config.password || decodeURIComponent(result.password);
      if (result.protocol == "socket:") {
        config.host = decodeURI(result.pathname);
        config.database = result.searchParams.get("db");
        config.client_encoding = result.searchParams.get("encoding");
        return config;
      }
      const hostname = dummyHost ? "" : result.hostname;
      if (!config.host) {
        config.host = decodeURIComponent(hostname);
      } else if (hostname && /^%2f/i.test(hostname)) {
        result.pathname = hostname + result.pathname;
      }
      if (!config.port) {
        config.port = result.port;
      }
      const pathname = result.pathname.slice(1) || null;
      config.database = pathname ? decodeURI(pathname) : null;
      if (config.ssl === "true" || config.ssl === "1") {
        config.ssl = true;
      }
      if (config.ssl === "0") {
        config.ssl = false;
      }
      if (config.sslcert || config.sslkey || config.sslrootcert || config.sslmode) {
        config.ssl = {};
      }
      const fs7 = config.sslcert || config.sslkey || config.sslrootcert ? __require("fs") : null;
      if (config.sslcert) {
        config.ssl.cert = fs7.readFileSync(config.sslcert).toString();
      }
      if (config.sslkey) {
        config.ssl.key = fs7.readFileSync(config.sslkey).toString();
      }
      if (config.sslrootcert) {
        config.ssl.ca = fs7.readFileSync(config.sslrootcert).toString();
      }
      if (options.useLibpqCompat && config.uselibpqcompat) {
        throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");
      }
      if (config.uselibpqcompat === "true" || options.useLibpqCompat) {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
          case "require": {
            if (config.sslrootcert) {
              config.ssl.checkServerIdentity = function() {
              };
            } else {
              config.ssl.rejectUnauthorized = false;
            }
            break;
          }
          case "verify-ca": {
            if (!config.ssl.ca) {
              throw new Error(
                "SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security."
              );
            }
            config.ssl.checkServerIdentity = function() {
            };
            break;
          }
          case "verify-full": {
            break;
          }
        }
      } else {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer":
          case "require":
          case "verify-ca":
          case "verify-full": {
            if (config.sslmode !== "verify-full") {
              deprecatedSslModeWarning(config.sslmode);
            }
            break;
          }
          case "no-verify": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
        }
      }
      return config;
    }
    function toConnectionOptions(sslConfig) {
      const connectionOptions = Object.entries(sslConfig).reduce((c, [key, value]) => {
        if (value !== void 0 && value !== null) {
          c[key] = value;
        }
        return c;
      }, {});
      return connectionOptions;
    }
    function toClientConfig(config) {
      const poolConfig = Object.entries(config).reduce((c, [key, value]) => {
        if (key === "ssl") {
          const sslConfig = value;
          if (typeof sslConfig === "boolean") {
            c[key] = sslConfig;
          }
          if (typeof sslConfig === "object") {
            c[key] = toConnectionOptions(sslConfig);
          }
        } else if (value !== void 0 && value !== null) {
          if (key === "port") {
            if (value !== "") {
              const v = parseInt(value, 10);
              if (isNaN(v)) {
                throw new Error(`Invalid ${key}: ${value}`);
              }
              c[key] = v;
            }
          } else {
            c[key] = value;
          }
        }
        return c;
      }, {});
      return poolConfig;
    }
    function parseIntoClientConfig(str) {
      return toClientConfig(parse(str));
    }
    function deprecatedSslModeWarning(sslmode) {
      if (!deprecatedSslModeWarning.warned && typeof process !== "undefined" && process.emitWarning) {
        deprecatedSslModeWarning.warned = true;
        process.emitWarning(`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=${sslmode}'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`);
      }
    }
    module.exports = parse;
    parse.parse = parse;
    parse.toClientConfig = toClientConfig;
    parse.parseIntoClientConfig = parseIntoClientConfig;
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/connection-parameters.js
var require_connection_parameters = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/connection-parameters.js"(exports, module) {
    "use strict";
    var dns = __require("dns");
    var defaults2 = require_defaults();
    var parse = require_pg_connection_string().parse;
    var val = function(key, config, envVar) {
      if (config[key]) {
        return config[key];
      }
      if (envVar === void 0) {
        envVar = process.env["PG" + key.toUpperCase()];
      } else if (envVar === false) {
      } else {
        envVar = process.env[envVar];
      }
      return envVar || defaults2[key];
    };
    var readSSLConfigFromEnvironment = function() {
      switch (process.env.PGSSLMODE) {
        case "disable":
          return false;
        case "prefer":
        case "require":
        case "verify-ca":
        case "verify-full":
          return true;
        case "no-verify":
          return { rejectUnauthorized: false };
      }
      return defaults2.ssl;
    };
    var quoteParamValue = function(value) {
      return "'" + ("" + value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    };
    var add = function(params, config, paramName) {
      const value = config[paramName];
      if (value !== void 0 && value !== null) {
        params.push(paramName + "=" + quoteParamValue(value));
      }
    };
    var ConnectionParameters = class {
      constructor(config) {
        config = typeof config === "string" ? parse(config) : config || {};
        if (config.connectionString) {
          config = Object.assign({}, config, parse(config.connectionString));
        }
        this.user = val("user", config);
        this.database = val("database", config);
        if (this.database === void 0) {
          this.database = this.user;
        }
        this.port = parseInt(val("port", config), 10);
        this.host = val("host", config);
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: val("password", config)
        });
        this.binary = val("binary", config);
        this.options = val("options", config);
        this.ssl = typeof config.ssl === "undefined" ? readSSLConfigFromEnvironment() : config.ssl;
        if (typeof this.ssl === "string") {
          if (this.ssl === "true") {
            this.ssl = true;
          }
        }
        if (this.ssl === "no-verify") {
          this.ssl = { rejectUnauthorized: false };
        }
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this.client_encoding = val("client_encoding", config);
        this.replication = val("replication", config);
        this.isDomainSocket = !(this.host || "").indexOf("/");
        this.application_name = val("application_name", config, "PGAPPNAME");
        this.fallback_application_name = val("fallback_application_name", config, false);
        this.statement_timeout = val("statement_timeout", config, false);
        this.lock_timeout = val("lock_timeout", config, false);
        this.idle_in_transaction_session_timeout = val("idle_in_transaction_session_timeout", config, false);
        this.query_timeout = val("query_timeout", config, false);
        if (config.connectionTimeoutMillis === void 0) {
          this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
        } else {
          this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1e3);
        }
        if (config.keepAlive === false) {
          this.keepalives = 0;
        } else if (config.keepAlive === true) {
          this.keepalives = 1;
        }
        if (typeof config.keepAliveInitialDelayMillis === "number") {
          this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1e3);
        }
      }
      getLibpqConnectionString(cb) {
        const params = [];
        add(params, this, "user");
        add(params, this, "password");
        add(params, this, "port");
        add(params, this, "application_name");
        add(params, this, "fallback_application_name");
        add(params, this, "connect_timeout");
        add(params, this, "options");
        const ssl = typeof this.ssl === "object" ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
        add(params, ssl, "sslmode");
        add(params, ssl, "sslca");
        add(params, ssl, "sslkey");
        add(params, ssl, "sslcert");
        add(params, ssl, "sslrootcert");
        if (this.database) {
          params.push("dbname=" + quoteParamValue(this.database));
        }
        if (this.replication) {
          params.push("replication=" + quoteParamValue(this.replication));
        }
        if (this.host) {
          params.push("host=" + quoteParamValue(this.host));
        }
        if (this.isDomainSocket) {
          return cb(null, params.join(" "));
        }
        if (this.client_encoding) {
          params.push("client_encoding=" + quoteParamValue(this.client_encoding));
        }
        dns.lookup(this.host, function(err, address) {
          if (err) return cb(err, null);
          params.push("hostaddr=" + quoteParamValue(address));
          return cb(null, params.join(" "));
        });
      }
    };
    module.exports = ConnectionParameters;
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/result.js
var require_result = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/result.js"(exports, module) {
    "use strict";
    var types2 = require_pg_types();
    var matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;
    var Result2 = class {
      constructor(rowMode, types3) {
        this.command = null;
        this.rowCount = null;
        this.oid = null;
        this.rows = [];
        this.fields = [];
        this._parsers = void 0;
        this._types = types3;
        this.RowCtor = null;
        this.rowAsArray = rowMode === "array";
        if (this.rowAsArray) {
          this.parseRow = this._parseRowAsArray;
        }
        this._prebuiltEmptyResultObject = null;
      }
      // adds a command complete message
      addCommandComplete(msg) {
        let match;
        if (msg.text) {
          match = matchRegexp.exec(msg.text);
        } else {
          match = matchRegexp.exec(msg.command);
        }
        if (match) {
          this.command = match[1];
          if (match[3]) {
            this.oid = parseInt(match[2], 10);
            this.rowCount = parseInt(match[3], 10);
          } else if (match[2]) {
            this.rowCount = parseInt(match[2], 10);
          }
        }
      }
      _parseRowAsArray(rowData) {
        const row = new Array(rowData.length);
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          if (rawValue !== null) {
            row[i] = this._parsers[i](rawValue);
          } else {
            row[i] = null;
          }
        }
        return row;
      }
      parseRow(rowData) {
        const row = { ...this._prebuiltEmptyResultObject };
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          const field = this.fields[i].name;
          if (rawValue !== null) {
            const v = this.fields[i].format === "binary" ? Buffer.from(rawValue) : rawValue;
            row[field] = this._parsers[i](v);
          } else {
            row[field] = null;
          }
        }
        return row;
      }
      addRow(row) {
        this.rows.push(row);
      }
      addFields(fieldDescriptions) {
        this.fields = fieldDescriptions;
        if (this.fields.length) {
          this._parsers = new Array(fieldDescriptions.length);
        }
        const row = {};
        for (let i = 0; i < fieldDescriptions.length; i++) {
          const desc = fieldDescriptions[i];
          row[desc.name] = null;
          if (this._types) {
            this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || "text");
          } else {
            this._parsers[i] = types2.getTypeParser(desc.dataTypeID, desc.format || "text");
          }
        }
        this._prebuiltEmptyResultObject = { ...row };
      }
    };
    module.exports = Result2;
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/query.js
var require_query = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/query.js"(exports, module) {
    "use strict";
    var { EventEmitter } = __require("events");
    var Result2 = require_result();
    var utils = require_utils();
    var Query2 = class extends EventEmitter {
      constructor(config, values, callback) {
        super();
        config = utils.normalizeQueryConfig(config, values, callback);
        this.text = config.text;
        this.values = config.values;
        this.rows = config.rows;
        this.types = config.types;
        this.name = config.name;
        this.queryMode = config.queryMode;
        this.binary = config.binary;
        this.portal = config.portal || "";
        this.callback = config.callback;
        this._rowMode = config.rowMode;
        if (process.domain && config.callback) {
          this.callback = process.domain.bind(config.callback);
        }
        this._result = new Result2(this._rowMode, this.types);
        this._results = this._result;
        this._canceledDueToError = false;
      }
      requiresPreparation() {
        if (this.queryMode === "extended") {
          return true;
        }
        if (this.name) {
          return true;
        }
        if (this.rows) {
          return true;
        }
        if (!this.text) {
          return false;
        }
        if (!this.values) {
          return false;
        }
        return this.values.length > 0;
      }
      _checkForMultirow() {
        if (this._result.command) {
          if (!Array.isArray(this._results)) {
            this._results = [this._result];
          }
          this._result = new Result2(this._rowMode, this._result._types);
          this._results.push(this._result);
        }
      }
      // associates row metadata from the supplied
      // message with this query object
      // metadata used when parsing row results
      handleRowDescription(msg) {
        this._checkForMultirow();
        this._result.addFields(msg.fields);
        this._accumulateRows = this.callback || !this.listeners("row").length;
      }
      handleDataRow(msg) {
        let row;
        if (this._canceledDueToError) {
          return;
        }
        try {
          row = this._result.parseRow(msg.fields);
        } catch (err) {
          this._canceledDueToError = err;
          return;
        }
        this.emit("row", row, this._result);
        if (this._accumulateRows) {
          this._result.addRow(row);
        }
      }
      handleCommandComplete(msg, connection) {
        this._checkForMultirow();
        this._result.addCommandComplete(msg);
        if (this.rows) {
          connection.sync();
        }
      }
      // if a named prepared statement is created with empty query text
      // the backend will send an emptyQuery message but *not* a command complete message
      // since we pipeline sync immediately after execute we don't need to do anything here
      // unless we have rows specified, in which case we did not pipeline the initial sync call
      handleEmptyQuery(connection) {
        if (this.rows) {
          connection.sync();
        }
      }
      handleError(err, connection) {
        if (this._canceledDueToError) {
          err = this._canceledDueToError;
          this._canceledDueToError = false;
        }
        if (this.callback) {
          return this.callback(err);
        }
        this.emit("error", err);
      }
      handleReadyForQuery(con) {
        if (this._canceledDueToError) {
          return this.handleError(this._canceledDueToError, con);
        }
        if (this.callback) {
          try {
            this.callback(null, this._results);
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        }
        this.emit("end", this._results);
      }
      submit(connection) {
        if (typeof this.text !== "string" && typeof this.name !== "string") {
          return new Error("A query must have either text or a name. Supplying neither is unsupported.");
        }
        const previous = connection.parsedStatements[this.name];
        if (this.text && previous && this.text !== previous) {
          return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
        }
        if (this.values && !Array.isArray(this.values)) {
          return new Error("Query values must be an array");
        }
        if (this.requiresPreparation()) {
          connection.stream.cork && connection.stream.cork();
          try {
            this.prepare(connection);
          } finally {
            connection.stream.uncork && connection.stream.uncork();
          }
        } else {
          connection.query(this.text);
        }
        return null;
      }
      hasBeenParsed(connection) {
        return this.name && connection.parsedStatements[this.name];
      }
      handlePortalSuspended(connection) {
        this._getRows(connection, this.rows);
      }
      _getRows(connection, rows) {
        connection.execute({
          portal: this.portal,
          rows
        });
        if (!rows) {
          connection.sync();
        } else {
          connection.flush();
        }
      }
      // http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
      prepare(connection) {
        if (!this.hasBeenParsed(connection)) {
          connection.parse({
            text: this.text,
            name: this.name,
            types: this.types
          });
        }
        try {
          connection.bind({
            portal: this.portal,
            statement: this.name,
            values: this.values,
            binary: this.binary,
            valueMapper: utils.prepareValue
          });
        } catch (err) {
          this.handleError(err, connection);
          return;
        }
        connection.describe({
          type: "P",
          name: this.portal || ""
        });
        this._getRows(connection, this.rows);
      }
      handleCopyInResponse(connection) {
        connection.sendCopyFail("No source stream defined");
      }
      handleCopyData(msg, connection) {
      }
    };
    module.exports = Query2;
  }
});

// node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/messages.js
var require_messages = __commonJS({
  "node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/messages.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoticeMessage = exports.DataRowMessage = exports.CommandCompleteMessage = exports.ReadyForQueryMessage = exports.NotificationResponseMessage = exports.BackendKeyDataMessage = exports.AuthenticationMD5Password = exports.ParameterStatusMessage = exports.ParameterDescriptionMessage = exports.RowDescriptionMessage = exports.Field = exports.CopyResponse = exports.CopyDataMessage = exports.DatabaseError = exports.copyDone = exports.emptyQuery = exports.replicationStart = exports.portalSuspended = exports.noData = exports.closeComplete = exports.bindComplete = exports.parseComplete = void 0;
    exports.parseComplete = {
      name: "parseComplete",
      length: 5
    };
    exports.bindComplete = {
      name: "bindComplete",
      length: 5
    };
    exports.closeComplete = {
      name: "closeComplete",
      length: 5
    };
    exports.noData = {
      name: "noData",
      length: 5
    };
    exports.portalSuspended = {
      name: "portalSuspended",
      length: 5
    };
    exports.replicationStart = {
      name: "replicationStart",
      length: 4
    };
    exports.emptyQuery = {
      name: "emptyQuery",
      length: 4
    };
    exports.copyDone = {
      name: "copyDone",
      length: 4
    };
    var DatabaseError2 = class extends Error {
      constructor(message, length, name) {
        super(message);
        this.length = length;
        this.name = name;
      }
    };
    exports.DatabaseError = DatabaseError2;
    var CopyDataMessage = class {
      constructor(length, chunk) {
        this.length = length;
        this.chunk = chunk;
        this.name = "copyData";
      }
    };
    exports.CopyDataMessage = CopyDataMessage;
    var CopyResponse = class {
      constructor(length, name, binary, columnCount) {
        this.length = length;
        this.name = name;
        this.binary = binary;
        this.columnTypes = new Array(columnCount);
      }
    };
    exports.CopyResponse = CopyResponse;
    var Field = class {
      constructor(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format) {
        this.name = name;
        this.tableID = tableID;
        this.columnID = columnID;
        this.dataTypeID = dataTypeID;
        this.dataTypeSize = dataTypeSize;
        this.dataTypeModifier = dataTypeModifier;
        this.format = format;
      }
    };
    exports.Field = Field;
    var RowDescriptionMessage = class {
      constructor(length, fieldCount) {
        this.length = length;
        this.fieldCount = fieldCount;
        this.name = "rowDescription";
        this.fields = new Array(this.fieldCount);
      }
    };
    exports.RowDescriptionMessage = RowDescriptionMessage;
    var ParameterDescriptionMessage = class {
      constructor(length, parameterCount) {
        this.length = length;
        this.parameterCount = parameterCount;
        this.name = "parameterDescription";
        this.dataTypeIDs = new Array(this.parameterCount);
      }
    };
    exports.ParameterDescriptionMessage = ParameterDescriptionMessage;
    var ParameterStatusMessage = class {
      constructor(length, parameterName, parameterValue) {
        this.length = length;
        this.parameterName = parameterName;
        this.parameterValue = parameterValue;
        this.name = "parameterStatus";
      }
    };
    exports.ParameterStatusMessage = ParameterStatusMessage;
    var AuthenticationMD5Password = class {
      constructor(length, salt) {
        this.length = length;
        this.salt = salt;
        this.name = "authenticationMD5Password";
      }
    };
    exports.AuthenticationMD5Password = AuthenticationMD5Password;
    var BackendKeyDataMessage = class {
      constructor(length, processID, secretKey) {
        this.length = length;
        this.processID = processID;
        this.secretKey = secretKey;
        this.name = "backendKeyData";
      }
    };
    exports.BackendKeyDataMessage = BackendKeyDataMessage;
    var NotificationResponseMessage = class {
      constructor(length, processId, channel, payload) {
        this.length = length;
        this.processId = processId;
        this.channel = channel;
        this.payload = payload;
        this.name = "notification";
      }
    };
    exports.NotificationResponseMessage = NotificationResponseMessage;
    var ReadyForQueryMessage = class {
      constructor(length, status) {
        this.length = length;
        this.status = status;
        this.name = "readyForQuery";
      }
    };
    exports.ReadyForQueryMessage = ReadyForQueryMessage;
    var CommandCompleteMessage = class {
      constructor(length, text) {
        this.length = length;
        this.text = text;
        this.name = "commandComplete";
      }
    };
    exports.CommandCompleteMessage = CommandCompleteMessage;
    var DataRowMessage = class {
      constructor(length, fields) {
        this.length = length;
        this.fields = fields;
        this.name = "dataRow";
        this.fieldCount = fields.length;
      }
    };
    exports.DataRowMessage = DataRowMessage;
    var NoticeMessage = class {
      constructor(length, message) {
        this.length = length;
        this.message = message;
        this.name = "notice";
      }
    };
    exports.NoticeMessage = NoticeMessage;
  }
});

// node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/buffer-writer.js
var require_buffer_writer = __commonJS({
  "node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/buffer-writer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Writer = void 0;
    var Writer = class {
      constructor(size = 256) {
        this.size = size;
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(size);
      }
      ensure(size) {
        const remaining = this.buffer.length - this.offset;
        if (remaining < size) {
          const oldBuffer = this.buffer;
          const newSize = oldBuffer.length + (oldBuffer.length >> 1) + size;
          this.buffer = Buffer.allocUnsafe(newSize);
          oldBuffer.copy(this.buffer);
        }
      }
      addInt32(num) {
        this.ensure(4);
        this.buffer[this.offset++] = num >>> 24 & 255;
        this.buffer[this.offset++] = num >>> 16 & 255;
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addInt16(num) {
        this.ensure(2);
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addCString(string) {
        if (!string) {
          this.ensure(1);
        } else {
          const len = Buffer.byteLength(string);
          this.ensure(len + 1);
          this.buffer.write(string, this.offset, "utf-8");
          this.offset += len;
        }
        this.buffer[this.offset++] = 0;
        return this;
      }
      addString(string = "") {
        const len = Buffer.byteLength(string);
        this.ensure(len);
        this.buffer.write(string, this.offset);
        this.offset += len;
        return this;
      }
      add(otherBuffer) {
        this.ensure(otherBuffer.length);
        otherBuffer.copy(this.buffer, this.offset);
        this.offset += otherBuffer.length;
        return this;
      }
      join(code) {
        if (code) {
          this.buffer[this.headerPosition] = code;
          const length = this.offset - (this.headerPosition + 1);
          this.buffer.writeInt32BE(length, this.headerPosition + 1);
        }
        return this.buffer.slice(code ? 0 : 5, this.offset);
      }
      flush(code) {
        const result = this.join(code);
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(this.size);
        return result;
      }
    };
    exports.Writer = Writer;
  }
});

// node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/serializer.js
var require_serializer = __commonJS({
  "node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/serializer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.serialize = void 0;
    var buffer_writer_1 = require_buffer_writer();
    var writer = new buffer_writer_1.Writer();
    var startup = (opts) => {
      writer.addInt16(3).addInt16(0);
      for (const key of Object.keys(opts)) {
        writer.addCString(key).addCString(opts[key]);
      }
      writer.addCString("client_encoding").addCString("UTF8");
      const bodyBuffer = writer.addCString("").flush();
      const length = bodyBuffer.length + 4;
      return new buffer_writer_1.Writer().addInt32(length).add(bodyBuffer).flush();
    };
    var requestSsl = () => {
      const response = Buffer.allocUnsafe(8);
      response.writeInt32BE(8, 0);
      response.writeInt32BE(80877103, 4);
      return response;
    };
    var password = (password2) => {
      return writer.addCString(password2).flush(
        112
        /* code.startup */
      );
    };
    var sendSASLInitialResponseMessage = function(mechanism, initialResponse) {
      writer.addCString(mechanism).addInt32(Buffer.byteLength(initialResponse)).addString(initialResponse);
      return writer.flush(
        112
        /* code.startup */
      );
    };
    var sendSCRAMClientFinalMessage = function(additionalData) {
      return writer.addString(additionalData).flush(
        112
        /* code.startup */
      );
    };
    var query = (text) => {
      return writer.addCString(text).flush(
        81
        /* code.query */
      );
    };
    var emptyArray = [];
    var parse = (query2) => {
      const name = query2.name || "";
      if (name.length > 63) {
        console.error("Warning! Postgres only supports 63 characters for query names.");
        console.error("You supplied %s (%s)", name, name.length);
        console.error("This can cause conflicts and silent errors executing queries");
      }
      const types2 = query2.types || emptyArray;
      const len = types2.length;
      const buffer = writer.addCString(name).addCString(query2.text).addInt16(len);
      for (let i = 0; i < len; i++) {
        buffer.addInt32(types2[i]);
      }
      return writer.flush(
        80
        /* code.parse */
      );
    };
    var paramWriter = new buffer_writer_1.Writer();
    var writeValues = function(values, valueMapper) {
      for (let i = 0; i < values.length; i++) {
        const mappedVal = valueMapper ? valueMapper(values[i], i) : values[i];
        if (mappedVal == null) {
          writer.addInt16(
            0
            /* ParamType.STRING */
          );
          paramWriter.addInt32(-1);
        } else if (mappedVal instanceof Buffer) {
          writer.addInt16(
            1
            /* ParamType.BINARY */
          );
          paramWriter.addInt32(mappedVal.length);
          paramWriter.add(mappedVal);
        } else {
          writer.addInt16(
            0
            /* ParamType.STRING */
          );
          paramWriter.addInt32(Buffer.byteLength(mappedVal));
          paramWriter.addString(mappedVal);
        }
      }
    };
    var bind = (config = {}) => {
      const portal = config.portal || "";
      const statement = config.statement || "";
      const binary = config.binary || false;
      const values = config.values || emptyArray;
      const len = values.length;
      writer.addCString(portal).addCString(statement);
      writer.addInt16(len);
      writeValues(values, config.valueMapper);
      writer.addInt16(len);
      writer.add(paramWriter.flush());
      writer.addInt16(1);
      writer.addInt16(
        binary ? 1 : 0
        /* ParamType.STRING */
      );
      return writer.flush(
        66
        /* code.bind */
      );
    };
    var emptyExecute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
    var execute = (config) => {
      if (!config || !config.portal && !config.rows) {
        return emptyExecute;
      }
      const portal = config.portal || "";
      const rows = config.rows || 0;
      const portalLength = Buffer.byteLength(portal);
      const len = 4 + portalLength + 1 + 4;
      const buff = Buffer.allocUnsafe(1 + len);
      buff[0] = 69;
      buff.writeInt32BE(len, 1);
      buff.write(portal, 5, "utf-8");
      buff[portalLength + 5] = 0;
      buff.writeUInt32BE(rows, buff.length - 4);
      return buff;
    };
    var cancel = (processID, secretKey) => {
      const buffer = Buffer.allocUnsafe(16);
      buffer.writeInt32BE(16, 0);
      buffer.writeInt16BE(1234, 4);
      buffer.writeInt16BE(5678, 6);
      buffer.writeInt32BE(processID, 8);
      buffer.writeInt32BE(secretKey, 12);
      return buffer;
    };
    var cstringMessage = (code, string) => {
      const stringLen = Buffer.byteLength(string);
      const len = 4 + stringLen + 1;
      const buffer = Buffer.allocUnsafe(1 + len);
      buffer[0] = code;
      buffer.writeInt32BE(len, 1);
      buffer.write(string, 5, "utf-8");
      buffer[len] = 0;
      return buffer;
    };
    var emptyDescribePortal = writer.addCString("P").flush(
      68
      /* code.describe */
    );
    var emptyDescribeStatement = writer.addCString("S").flush(
      68
      /* code.describe */
    );
    var describe = (msg) => {
      return msg.name ? cstringMessage(68, `${msg.type}${msg.name || ""}`) : msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
    };
    var close = (msg) => {
      const text = `${msg.type}${msg.name || ""}`;
      return cstringMessage(67, text);
    };
    var copyData = (chunk) => {
      return writer.add(chunk).flush(
        100
        /* code.copyFromChunk */
      );
    };
    var copyFail = (message) => {
      return cstringMessage(102, message);
    };
    var codeOnlyBuffer = (code) => Buffer.from([code, 0, 0, 0, 4]);
    var flushBuffer = codeOnlyBuffer(
      72
      /* code.flush */
    );
    var syncBuffer = codeOnlyBuffer(
      83
      /* code.sync */
    );
    var endBuffer = codeOnlyBuffer(
      88
      /* code.end */
    );
    var copyDoneBuffer = codeOnlyBuffer(
      99
      /* code.copyDone */
    );
    var serialize = {
      startup,
      password,
      requestSsl,
      sendSASLInitialResponseMessage,
      sendSCRAMClientFinalMessage,
      query,
      parse,
      bind,
      execute,
      describe,
      close,
      flush: () => flushBuffer,
      sync: () => syncBuffer,
      end: () => endBuffer,
      copyData,
      copyDone: () => copyDoneBuffer,
      copyFail,
      cancel
    };
    exports.serialize = serialize;
  }
});

// node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/buffer-reader.js
var require_buffer_reader = __commonJS({
  "node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/buffer-reader.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BufferReader = void 0;
    var BufferReader = class {
      constructor(offset = 0) {
        this.offset = offset;
        this.buffer = Buffer.allocUnsafe(0);
        this.encoding = "utf-8";
      }
      setBuffer(offset, buffer) {
        this.offset = offset;
        this.buffer = buffer;
      }
      int16() {
        const result = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return result;
      }
      byte() {
        const result = this.buffer[this.offset];
        this.offset++;
        return result;
      }
      int32() {
        const result = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      uint32() {
        const result = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return result;
      }
      string(length) {
        const result = this.buffer.toString(this.encoding, this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
      cstring() {
        const start = this.offset;
        let end = start;
        while (this.buffer[end++] !== 0) {
        }
        this.offset = end;
        return this.buffer.toString(this.encoding, start, end - 1);
      }
      bytes(length) {
        const result = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return result;
      }
    };
    exports.BufferReader = BufferReader;
  }
});

// node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/parser.js
var require_parser = __commonJS({
  "node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/parser.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Parser = void 0;
    var messages_1 = require_messages();
    var buffer_reader_1 = require_buffer_reader();
    var CODE_LENGTH = 1;
    var LEN_LENGTH = 4;
    var HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
    var LATEINIT_LENGTH = -1;
    var emptyBuffer = Buffer.allocUnsafe(0);
    var Parser = class {
      constructor(opts) {
        this.buffer = emptyBuffer;
        this.bufferLength = 0;
        this.bufferOffset = 0;
        this.reader = new buffer_reader_1.BufferReader();
        if ((opts === null || opts === void 0 ? void 0 : opts.mode) === "binary") {
          throw new Error("Binary mode not supported yet");
        }
        this.mode = (opts === null || opts === void 0 ? void 0 : opts.mode) || "text";
      }
      parse(buffer, callback) {
        this.mergeBuffer(buffer);
        const bufferFullLength = this.bufferOffset + this.bufferLength;
        let offset = this.bufferOffset;
        while (offset + HEADER_LENGTH <= bufferFullLength) {
          const code = this.buffer[offset];
          const length = this.buffer.readUInt32BE(offset + CODE_LENGTH);
          const fullMessageLength = CODE_LENGTH + length;
          if (fullMessageLength + offset <= bufferFullLength) {
            const message = this.handlePacket(offset + HEADER_LENGTH, code, length, this.buffer);
            callback(message);
            offset += fullMessageLength;
          } else {
            break;
          }
        }
        if (offset === bufferFullLength) {
          this.buffer = emptyBuffer;
          this.bufferLength = 0;
          this.bufferOffset = 0;
        } else {
          this.bufferLength = bufferFullLength - offset;
          this.bufferOffset = offset;
        }
      }
      mergeBuffer(buffer) {
        if (this.bufferLength > 0) {
          const newLength = this.bufferLength + buffer.byteLength;
          const newFullLength = newLength + this.bufferOffset;
          if (newFullLength > this.buffer.byteLength) {
            let newBuffer;
            if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
              newBuffer = this.buffer;
            } else {
              let newBufferLength = this.buffer.byteLength * 2;
              while (newLength >= newBufferLength) {
                newBufferLength *= 2;
              }
              newBuffer = Buffer.allocUnsafe(newBufferLength);
            }
            this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength);
            this.buffer = newBuffer;
            this.bufferOffset = 0;
          }
          buffer.copy(this.buffer, this.bufferOffset + this.bufferLength);
          this.bufferLength = newLength;
        } else {
          this.buffer = buffer;
          this.bufferOffset = 0;
          this.bufferLength = buffer.byteLength;
        }
      }
      handlePacket(offset, code, length, bytes) {
        const { reader } = this;
        reader.setBuffer(offset, bytes);
        let message;
        switch (code) {
          case 50:
            message = messages_1.bindComplete;
            break;
          case 49:
            message = messages_1.parseComplete;
            break;
          case 51:
            message = messages_1.closeComplete;
            break;
          case 110:
            message = messages_1.noData;
            break;
          case 115:
            message = messages_1.portalSuspended;
            break;
          case 99:
            message = messages_1.copyDone;
            break;
          case 87:
            message = messages_1.replicationStart;
            break;
          case 73:
            message = messages_1.emptyQuery;
            break;
          case 68:
            message = parseDataRowMessage(reader);
            break;
          case 67:
            message = parseCommandCompleteMessage(reader);
            break;
          case 90:
            message = parseReadyForQueryMessage(reader);
            break;
          case 65:
            message = parseNotificationMessage(reader);
            break;
          case 82:
            message = parseAuthenticationResponse(reader, length);
            break;
          case 83:
            message = parseParameterStatusMessage(reader);
            break;
          case 75:
            message = parseBackendKeyData(reader);
            break;
          case 69:
            message = parseErrorMessage(reader, "error");
            break;
          case 78:
            message = parseErrorMessage(reader, "notice");
            break;
          case 84:
            message = parseRowDescriptionMessage(reader);
            break;
          case 116:
            message = parseParameterDescriptionMessage(reader);
            break;
          case 71:
            message = parseCopyInMessage(reader);
            break;
          case 72:
            message = parseCopyOutMessage(reader);
            break;
          case 100:
            message = parseCopyData(reader, length);
            break;
          default:
            return new messages_1.DatabaseError("received invalid response: " + code.toString(16), length, "error");
        }
        reader.setBuffer(0, emptyBuffer);
        message.length = length;
        return message;
      }
    };
    exports.Parser = Parser;
    var parseReadyForQueryMessage = (reader) => {
      const status = reader.string(1);
      return new messages_1.ReadyForQueryMessage(LATEINIT_LENGTH, status);
    };
    var parseCommandCompleteMessage = (reader) => {
      const text = reader.cstring();
      return new messages_1.CommandCompleteMessage(LATEINIT_LENGTH, text);
    };
    var parseCopyData = (reader, length) => {
      const chunk = reader.bytes(length - 4);
      return new messages_1.CopyDataMessage(LATEINIT_LENGTH, chunk);
    };
    var parseCopyInMessage = (reader) => parseCopyMessage(reader, "copyInResponse");
    var parseCopyOutMessage = (reader) => parseCopyMessage(reader, "copyOutResponse");
    var parseCopyMessage = (reader, messageName) => {
      const isBinary = reader.byte() !== 0;
      const columnCount = reader.int16();
      const message = new messages_1.CopyResponse(LATEINIT_LENGTH, messageName, isBinary, columnCount);
      for (let i = 0; i < columnCount; i++) {
        message.columnTypes[i] = reader.int16();
      }
      return message;
    };
    var parseNotificationMessage = (reader) => {
      const processId = reader.int32();
      const channel = reader.cstring();
      const payload = reader.cstring();
      return new messages_1.NotificationResponseMessage(LATEINIT_LENGTH, processId, channel, payload);
    };
    var parseRowDescriptionMessage = (reader) => {
      const fieldCount = reader.int16();
      const message = new messages_1.RowDescriptionMessage(LATEINIT_LENGTH, fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        message.fields[i] = parseField(reader);
      }
      return message;
    };
    var parseField = (reader) => {
      const name = reader.cstring();
      const tableID = reader.uint32();
      const columnID = reader.int16();
      const dataTypeID = reader.uint32();
      const dataTypeSize = reader.int16();
      const dataTypeModifier = reader.int32();
      const mode = reader.int16() === 0 ? "text" : "binary";
      return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
    };
    var parseParameterDescriptionMessage = (reader) => {
      const parameterCount = reader.int16();
      const message = new messages_1.ParameterDescriptionMessage(LATEINIT_LENGTH, parameterCount);
      for (let i = 0; i < parameterCount; i++) {
        message.dataTypeIDs[i] = reader.int32();
      }
      return message;
    };
    var parseDataRowMessage = (reader) => {
      const fieldCount = reader.int16();
      const fields = new Array(fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        const len = reader.int32();
        fields[i] = len === -1 ? null : reader.string(len);
      }
      return new messages_1.DataRowMessage(LATEINIT_LENGTH, fields);
    };
    var parseParameterStatusMessage = (reader) => {
      const name = reader.cstring();
      const value = reader.cstring();
      return new messages_1.ParameterStatusMessage(LATEINIT_LENGTH, name, value);
    };
    var parseBackendKeyData = (reader) => {
      const processID = reader.int32();
      const secretKey = reader.int32();
      return new messages_1.BackendKeyDataMessage(LATEINIT_LENGTH, processID, secretKey);
    };
    var parseAuthenticationResponse = (reader, length) => {
      const code = reader.int32();
      const message = {
        name: "authenticationOk",
        length
      };
      switch (code) {
        case 0:
          break;
        case 3:
          if (message.length === 8) {
            message.name = "authenticationCleartextPassword";
          }
          break;
        case 5:
          if (message.length === 12) {
            message.name = "authenticationMD5Password";
            const salt = reader.bytes(4);
            return new messages_1.AuthenticationMD5Password(LATEINIT_LENGTH, salt);
          }
          break;
        case 10:
          {
            message.name = "authenticationSASL";
            message.mechanisms = [];
            let mechanism;
            do {
              mechanism = reader.cstring();
              if (mechanism) {
                message.mechanisms.push(mechanism);
              }
            } while (mechanism);
          }
          break;
        case 11:
          message.name = "authenticationSASLContinue";
          message.data = reader.string(length - 8);
          break;
        case 12:
          message.name = "authenticationSASLFinal";
          message.data = reader.string(length - 8);
          break;
        default:
          throw new Error("Unknown authenticationOk message type " + code);
      }
      return message;
    };
    var parseErrorMessage = (reader, name) => {
      const fields = {};
      let fieldType = reader.string(1);
      while (fieldType !== "\0") {
        fields[fieldType] = reader.cstring();
        fieldType = reader.string(1);
      }
      const messageValue = fields.M;
      const message = name === "notice" ? new messages_1.NoticeMessage(LATEINIT_LENGTH, messageValue) : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
      message.severity = fields.S;
      message.code = fields.C;
      message.detail = fields.D;
      message.hint = fields.H;
      message.position = fields.P;
      message.internalPosition = fields.p;
      message.internalQuery = fields.q;
      message.where = fields.W;
      message.schema = fields.s;
      message.table = fields.t;
      message.column = fields.c;
      message.dataType = fields.d;
      message.constraint = fields.n;
      message.file = fields.F;
      message.line = fields.L;
      message.routine = fields.R;
      return message;
    };
  }
});

// node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/index.js
var require_dist = __commonJS({
  "node_modules/.pnpm/pg-protocol@1.13.0/node_modules/pg-protocol/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DatabaseError = exports.serialize = exports.parse = void 0;
    var messages_1 = require_messages();
    Object.defineProperty(exports, "DatabaseError", { enumerable: true, get: function() {
      return messages_1.DatabaseError;
    } });
    var serializer_1 = require_serializer();
    Object.defineProperty(exports, "serialize", { enumerable: true, get: function() {
      return serializer_1.serialize;
    } });
    var parser_1 = require_parser();
    function parse(stream, callback) {
      const parser = new parser_1.Parser();
      stream.on("data", (buffer) => parser.parse(buffer, callback));
      return new Promise((resolve2) => stream.on("end", () => resolve2()));
    }
    exports.parse = parse;
  }
});

// node_modules/.pnpm/pg-cloudflare@1.3.0/node_modules/pg-cloudflare/dist/empty.js
var require_empty = __commonJS({
  "node_modules/.pnpm/pg-cloudflare@1.3.0/node_modules/pg-cloudflare/dist/empty.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = {};
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/stream.js
var require_stream = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/stream.js"(exports, module) {
    var { getStream, getSecureStream } = getStreamFuncs();
    module.exports = {
      /**
       * Get a socket stream compatible with the current runtime environment.
       * @returns {Duplex}
       */
      getStream,
      /**
       * Get a TLS secured socket, compatible with the current environment,
       * using the socket and other settings given in `options`.
       * @returns {Duplex}
       */
      getSecureStream
    };
    function getNodejsStreamFuncs() {
      function getStream2(ssl) {
        const net = __require("net");
        return new net.Socket();
      }
      function getSecureStream2(options) {
        const tls = __require("tls");
        return tls.connect(options);
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function getCloudflareStreamFuncs() {
      function getStream2(ssl) {
        const { CloudflareSocket } = require_empty();
        return new CloudflareSocket(ssl);
      }
      function getSecureStream2(options) {
        options.socket.startTls(options);
        return options.socket;
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function isCloudflareRuntime() {
      if (typeof navigator === "object" && navigator !== null && typeof navigator.userAgent === "string") {
        return navigator.userAgent === "Cloudflare-Workers";
      }
      if (typeof Response === "function") {
        const resp = new Response(null, { cf: { thing: true } });
        if (typeof resp.cf === "object" && resp.cf !== null && resp.cf.thing) {
          return true;
        }
      }
      return false;
    }
    function getStreamFuncs() {
      if (isCloudflareRuntime()) {
        return getCloudflareStreamFuncs();
      }
      return getNodejsStreamFuncs();
    }
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/connection.js
var require_connection = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/connection.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var { parse, serialize } = require_dist();
    var { getStream, getSecureStream } = require_stream();
    var flushBuffer = serialize.flush();
    var syncBuffer = serialize.sync();
    var endBuffer = serialize.end();
    var Connection2 = class extends EventEmitter {
      constructor(config) {
        super();
        config = config || {};
        this.stream = config.stream || getStream(config.ssl);
        if (typeof this.stream === "function") {
          this.stream = this.stream(config);
        }
        this._keepAlive = config.keepAlive;
        this._keepAliveInitialDelayMillis = config.keepAliveInitialDelayMillis;
        this.parsedStatements = {};
        this.ssl = config.ssl || false;
        this._ending = false;
        this._emitMessage = false;
        const self = this;
        this.on("newListener", function(eventName) {
          if (eventName === "message") {
            self._emitMessage = true;
          }
        });
      }
      connect(port, host) {
        const self = this;
        this._connecting = true;
        this.stream.setNoDelay(true);
        this.stream.connect(port, host);
        this.stream.once("connect", function() {
          if (self._keepAlive) {
            self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis);
          }
          self.emit("connect");
        });
        const reportStreamError = function(error) {
          if (self._ending && (error.code === "ECONNRESET" || error.code === "EPIPE")) {
            return;
          }
          self.emit("error", error);
        };
        this.stream.on("error", reportStreamError);
        this.stream.on("close", function() {
          self.emit("end");
        });
        if (!this.ssl) {
          return this.attachListeners(this.stream);
        }
        this.stream.once("data", function(buffer) {
          const responseCode = buffer.toString("utf8");
          switch (responseCode) {
            case "S":
              break;
            case "N":
              self.stream.end();
              return self.emit("error", new Error("The server does not support SSL connections"));
            default:
              self.stream.end();
              return self.emit("error", new Error("There was an error establishing an SSL connection"));
          }
          const options = {
            socket: self.stream
          };
          if (self.ssl !== true) {
            Object.assign(options, self.ssl);
            if ("key" in self.ssl) {
              options.key = self.ssl.key;
            }
          }
          const net = __require("net");
          if (net.isIP && net.isIP(host) === 0) {
            options.servername = host;
          }
          try {
            self.stream = getSecureStream(options);
          } catch (err) {
            return self.emit("error", err);
          }
          self.attachListeners(self.stream);
          self.stream.on("error", reportStreamError);
          self.emit("sslconnect");
        });
      }
      attachListeners(stream) {
        parse(stream, (msg) => {
          const eventName = msg.name === "error" ? "errorMessage" : msg.name;
          if (this._emitMessage) {
            this.emit("message", msg);
          }
          this.emit(eventName, msg);
        });
      }
      requestSsl() {
        this.stream.write(serialize.requestSsl());
      }
      startup(config) {
        this.stream.write(serialize.startup(config));
      }
      cancel(processID, secretKey) {
        this._send(serialize.cancel(processID, secretKey));
      }
      password(password) {
        this._send(serialize.password(password));
      }
      sendSASLInitialResponseMessage(mechanism, initialResponse) {
        this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
      }
      sendSCRAMClientFinalMessage(additionalData) {
        this._send(serialize.sendSCRAMClientFinalMessage(additionalData));
      }
      _send(buffer) {
        if (!this.stream.writable) {
          return false;
        }
        return this.stream.write(buffer);
      }
      query(text) {
        this._send(serialize.query(text));
      }
      // send parse message
      parse(query) {
        this._send(serialize.parse(query));
      }
      // send bind message
      bind(config) {
        this._send(serialize.bind(config));
      }
      // send execute message
      execute(config) {
        this._send(serialize.execute(config));
      }
      flush() {
        if (this.stream.writable) {
          this.stream.write(flushBuffer);
        }
      }
      sync() {
        this._ending = true;
        this._send(syncBuffer);
      }
      ref() {
        this.stream.ref();
      }
      unref() {
        this.stream.unref();
      }
      end() {
        this._ending = true;
        if (!this._connecting || !this.stream.writable) {
          this.stream.end();
          return;
        }
        return this.stream.write(endBuffer, () => {
          this.stream.end();
        });
      }
      close(msg) {
        this._send(serialize.close(msg));
      }
      describe(msg) {
        this._send(serialize.describe(msg));
      }
      sendCopyFromChunk(chunk) {
        this._send(serialize.copyData(chunk));
      }
      endCopyFrom() {
        this._send(serialize.copyDone());
      }
      sendCopyFail(msg) {
        this._send(serialize.copyFail(msg));
      }
    };
    module.exports = Connection2;
  }
});

// node_modules/.pnpm/split2@4.2.0/node_modules/split2/index.js
var require_split2 = __commonJS({
  "node_modules/.pnpm/split2@4.2.0/node_modules/split2/index.js"(exports, module) {
    "use strict";
    var { Transform } = __require("stream");
    var { StringDecoder } = __require("string_decoder");
    var kLast = /* @__PURE__ */ Symbol("last");
    var kDecoder = /* @__PURE__ */ Symbol("decoder");
    function transform(chunk, enc, cb) {
      let list;
      if (this.overflow) {
        const buf = this[kDecoder].write(chunk);
        list = buf.split(this.matcher);
        if (list.length === 1) return cb();
        list.shift();
        this.overflow = false;
      } else {
        this[kLast] += this[kDecoder].write(chunk);
        list = this[kLast].split(this.matcher);
      }
      this[kLast] = list.pop();
      for (let i = 0; i < list.length; i++) {
        try {
          push(this, this.mapper(list[i]));
        } catch (error) {
          return cb(error);
        }
      }
      this.overflow = this[kLast].length > this.maxLength;
      if (this.overflow && !this.skipOverflow) {
        cb(new Error("maximum buffer reached"));
        return;
      }
      cb();
    }
    function flush(cb) {
      this[kLast] += this[kDecoder].end();
      if (this[kLast]) {
        try {
          push(this, this.mapper(this[kLast]));
        } catch (error) {
          return cb(error);
        }
      }
      cb();
    }
    function push(self, val) {
      if (val !== void 0) {
        self.push(val);
      }
    }
    function noop(incoming) {
      return incoming;
    }
    function split(matcher, mapper, options) {
      matcher = matcher || /\r?\n/;
      mapper = mapper || noop;
      options = options || {};
      switch (arguments.length) {
        case 1:
          if (typeof matcher === "function") {
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof matcher === "object" && !(matcher instanceof RegExp) && !matcher[Symbol.split]) {
            options = matcher;
            matcher = /\r?\n/;
          }
          break;
        case 2:
          if (typeof matcher === "function") {
            options = mapper;
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof mapper === "object") {
            options = mapper;
            mapper = noop;
          }
      }
      options = Object.assign({}, options);
      options.autoDestroy = true;
      options.transform = transform;
      options.flush = flush;
      options.readableObjectMode = true;
      const stream = new Transform(options);
      stream[kLast] = "";
      stream[kDecoder] = new StringDecoder("utf8");
      stream.matcher = matcher;
      stream.mapper = mapper;
      stream.maxLength = options.maxLength;
      stream.skipOverflow = options.skipOverflow || false;
      stream.overflow = false;
      stream._destroy = function(err, cb) {
        this._writableState.errorEmitted = false;
        cb(err);
      };
      return stream;
    }
    module.exports = split;
  }
});

// node_modules/.pnpm/pgpass@1.0.5/node_modules/pgpass/lib/helper.js
var require_helper = __commonJS({
  "node_modules/.pnpm/pgpass@1.0.5/node_modules/pgpass/lib/helper.js"(exports, module) {
    "use strict";
    var path6 = __require("path");
    var Stream = __require("stream").Stream;
    var split = require_split2();
    var util = __require("util");
    var defaultPort = 5432;
    var isWin = process.platform === "win32";
    var warnStream = process.stderr;
    var S_IRWXG = 56;
    var S_IRWXO = 7;
    var S_IFMT = 61440;
    var S_IFREG = 32768;
    function isRegFile(mode) {
      return (mode & S_IFMT) == S_IFREG;
    }
    var fieldNames = ["host", "port", "database", "user", "password"];
    var nrOfFields = fieldNames.length;
    var passKey = fieldNames[nrOfFields - 1];
    function warn() {
      var isWritable = warnStream instanceof Stream && true === warnStream.writable;
      if (isWritable) {
        var args = Array.prototype.slice.call(arguments).concat("\n");
        warnStream.write(util.format.apply(util, args));
      }
    }
    Object.defineProperty(module.exports, "isWin", {
      get: function() {
        return isWin;
      },
      set: function(val) {
        isWin = val;
      }
    });
    module.exports.warnTo = function(stream) {
      var old = warnStream;
      warnStream = stream;
      return old;
    };
    module.exports.getFileName = function(rawEnv) {
      var env = rawEnv || process.env;
      var file = env.PGPASSFILE || (isWin ? path6.join(env.APPDATA || "./", "postgresql", "pgpass.conf") : path6.join(env.HOME || "./", ".pgpass"));
      return file;
    };
    module.exports.usePgPass = function(stats, fname) {
      if (Object.prototype.hasOwnProperty.call(process.env, "PGPASSWORD")) {
        return false;
      }
      if (isWin) {
        return true;
      }
      fname = fname || "<unkn>";
      if (!isRegFile(stats.mode)) {
        warn('WARNING: password file "%s" is not a plain file', fname);
        return false;
      }
      if (stats.mode & (S_IRWXG | S_IRWXO)) {
        warn('WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less', fname);
        return false;
      }
      return true;
    };
    var matcher = module.exports.match = function(connInfo, entry) {
      return fieldNames.slice(0, -1).reduce(function(prev, field, idx) {
        if (idx == 1) {
          if (Number(connInfo[field] || defaultPort) === Number(entry[field])) {
            return prev && true;
          }
        }
        return prev && (entry[field] === "*" || entry[field] === connInfo[field]);
      }, true);
    };
    module.exports.getPassword = function(connInfo, stream, cb) {
      var pass;
      var lineStream = stream.pipe(split());
      function onLine(line) {
        var entry = parseLine(line);
        if (entry && isValidEntry(entry) && matcher(connInfo, entry)) {
          pass = entry[passKey];
          lineStream.end();
        }
      }
      var onEnd = function() {
        stream.destroy();
        cb(pass);
      };
      var onErr = function(err) {
        stream.destroy();
        warn("WARNING: error on reading file: %s", err);
        cb(void 0);
      };
      stream.on("error", onErr);
      lineStream.on("data", onLine).on("end", onEnd).on("error", onErr);
    };
    var parseLine = module.exports.parseLine = function(line) {
      if (line.length < 11 || line.match(/^\s+#/)) {
        return null;
      }
      var curChar = "";
      var prevChar = "";
      var fieldIdx = 0;
      var startIdx = 0;
      var endIdx = 0;
      var obj = {};
      var isLastField = false;
      var addToObj = function(idx, i0, i1) {
        var field = line.substring(i0, i1);
        if (!Object.hasOwnProperty.call(process.env, "PGPASS_NO_DEESCAPE")) {
          field = field.replace(/\\([:\\])/g, "$1");
        }
        obj[fieldNames[idx]] = field;
      };
      for (var i = 0; i < line.length - 1; i += 1) {
        curChar = line.charAt(i + 1);
        prevChar = line.charAt(i);
        isLastField = fieldIdx == nrOfFields - 1;
        if (isLastField) {
          addToObj(fieldIdx, startIdx);
          break;
        }
        if (i >= 0 && curChar == ":" && prevChar !== "\\") {
          addToObj(fieldIdx, startIdx, i + 1);
          startIdx = i + 2;
          fieldIdx += 1;
        }
      }
      obj = Object.keys(obj).length === nrOfFields ? obj : null;
      return obj;
    };
    var isValidEntry = module.exports.isValidEntry = function(entry) {
      var rules = {
        // host
        0: function(x) {
          return x.length > 0;
        },
        // port
        1: function(x) {
          if (x === "*") {
            return true;
          }
          x = Number(x);
          return isFinite(x) && x > 0 && x < 9007199254740992 && Math.floor(x) === x;
        },
        // database
        2: function(x) {
          return x.length > 0;
        },
        // username
        3: function(x) {
          return x.length > 0;
        },
        // password
        4: function(x) {
          return x.length > 0;
        }
      };
      for (var idx = 0; idx < fieldNames.length; idx += 1) {
        var rule = rules[idx];
        var value = entry[fieldNames[idx]] || "";
        var res = rule(value);
        if (!res) {
          return false;
        }
      }
      return true;
    };
  }
});

// node_modules/.pnpm/pgpass@1.0.5/node_modules/pgpass/lib/index.js
var require_lib = __commonJS({
  "node_modules/.pnpm/pgpass@1.0.5/node_modules/pgpass/lib/index.js"(exports, module) {
    "use strict";
    var path6 = __require("path");
    var fs7 = __require("fs");
    var helper = require_helper();
    module.exports = function(connInfo, cb) {
      var file = helper.getFileName();
      fs7.stat(file, function(err, stat) {
        if (err || !helper.usePgPass(stat, file)) {
          return cb(void 0);
        }
        var st = fs7.createReadStream(file);
        helper.getPassword(connInfo, st, cb);
      });
    };
    module.exports.warnTo = helper.warnTo;
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/client.js
var require_client = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/client.js"(exports, module) {
    var EventEmitter = __require("events").EventEmitter;
    var utils = require_utils();
    var nodeUtils = __require("util");
    var sasl = require_sasl();
    var TypeOverrides2 = require_type_overrides();
    var ConnectionParameters = require_connection_parameters();
    var Query2 = require_query();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var crypto2 = require_utils2();
    var activeQueryDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.activeQuery is deprecated and will be removed in pg@9.0"
    );
    var queryQueueDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.queryQueue is deprecated and will be removed in pg@9.0."
    );
    var pgPassDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "pgpass support is deprecated and will be removed in pg@9.0. You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code."
    );
    var byoPromiseDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0."
    );
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = class extends EventEmitter {
      constructor(config) {
        super();
        this.connectionParameters = new ConnectionParameters(config);
        this.user = this.connectionParameters.user;
        this.database = this.connectionParameters.database;
        this.port = this.connectionParameters.port;
        this.host = this.connectionParameters.host;
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: this.connectionParameters.password
        });
        this.replication = this.connectionParameters.replication;
        const c = config || {};
        if (c.Promise) {
          byoPromiseDeprecationNotice();
        }
        this._Promise = c.Promise || global.Promise;
        this._types = new TypeOverrides2(c.types);
        this._ending = false;
        this._ended = false;
        this._connecting = false;
        this._connected = false;
        this._connectionError = false;
        this._queryable = true;
        this._activeQuery = null;
        this.enableChannelBinding = Boolean(c.enableChannelBinding);
        this.connection = c.connection || new Connection2({
          stream: c.stream,
          ssl: this.connectionParameters.ssl,
          keepAlive: c.keepAlive || false,
          keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
          encoding: this.connectionParameters.client_encoding || "utf8"
        });
        this._queryQueue = [];
        this.binary = c.binary || defaults2.binary;
        this.processID = null;
        this.secretKey = null;
        this.ssl = this.connectionParameters.ssl || false;
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0;
      }
      get activeQuery() {
        activeQueryDeprecationNotice();
        return this._activeQuery;
      }
      set activeQuery(val) {
        activeQueryDeprecationNotice();
        this._activeQuery = val;
      }
      _getActiveQuery() {
        return this._activeQuery;
      }
      _errorAllQueries(err) {
        const enqueueError = (query) => {
          process.nextTick(() => {
            query.handleError(err, this.connection);
          });
        };
        const activeQuery = this._getActiveQuery();
        if (activeQuery) {
          enqueueError(activeQuery);
          this._activeQuery = null;
        }
        this._queryQueue.forEach(enqueueError);
        this._queryQueue.length = 0;
      }
      _connect(callback) {
        const self = this;
        const con = this.connection;
        this._connectionCallback = callback;
        if (this._connecting || this._connected) {
          const err = new Error("Client has already been connected. You cannot reuse a client.");
          process.nextTick(() => {
            callback(err);
          });
          return;
        }
        this._connecting = true;
        if (this._connectionTimeoutMillis > 0) {
          this.connectionTimeoutHandle = setTimeout(() => {
            con._ending = true;
            con.stream.destroy(new Error("timeout expired"));
          }, this._connectionTimeoutMillis);
          if (this.connectionTimeoutHandle.unref) {
            this.connectionTimeoutHandle.unref();
          }
        }
        if (this.host && this.host.indexOf("/") === 0) {
          con.connect(this.host + "/.s.PGSQL." + this.port);
        } else {
          con.connect(this.port, this.host);
        }
        con.on("connect", function() {
          if (self.ssl) {
            con.requestSsl();
          } else {
            con.startup(self.getStartupConf());
          }
        });
        con.on("sslconnect", function() {
          con.startup(self.getStartupConf());
        });
        this._attachListeners(con);
        con.once("end", () => {
          const error = this._ending ? new Error("Connection terminated") : new Error("Connection terminated unexpectedly");
          clearTimeout(this.connectionTimeoutHandle);
          this._errorAllQueries(error);
          this._ended = true;
          if (!this._ending) {
            if (this._connecting && !this._connectionError) {
              if (this._connectionCallback) {
                this._connectionCallback(error);
              } else {
                this._handleErrorEvent(error);
              }
            } else if (!this._connectionError) {
              this._handleErrorEvent(error);
            }
          }
          process.nextTick(() => {
            this.emit("end");
          });
        });
      }
      connect(callback) {
        if (callback) {
          this._connect(callback);
          return;
        }
        return new this._Promise((resolve2, reject) => {
          this._connect((error) => {
            if (error) {
              reject(error);
            } else {
              resolve2(this);
            }
          });
        });
      }
      _attachListeners(con) {
        con.on("authenticationCleartextPassword", this._handleAuthCleartextPassword.bind(this));
        con.on("authenticationMD5Password", this._handleAuthMD5Password.bind(this));
        con.on("authenticationSASL", this._handleAuthSASL.bind(this));
        con.on("authenticationSASLContinue", this._handleAuthSASLContinue.bind(this));
        con.on("authenticationSASLFinal", this._handleAuthSASLFinal.bind(this));
        con.on("backendKeyData", this._handleBackendKeyData.bind(this));
        con.on("error", this._handleErrorEvent.bind(this));
        con.on("errorMessage", this._handleErrorMessage.bind(this));
        con.on("readyForQuery", this._handleReadyForQuery.bind(this));
        con.on("notice", this._handleNotice.bind(this));
        con.on("rowDescription", this._handleRowDescription.bind(this));
        con.on("dataRow", this._handleDataRow.bind(this));
        con.on("portalSuspended", this._handlePortalSuspended.bind(this));
        con.on("emptyQuery", this._handleEmptyQuery.bind(this));
        con.on("commandComplete", this._handleCommandComplete.bind(this));
        con.on("parseComplete", this._handleParseComplete.bind(this));
        con.on("copyInResponse", this._handleCopyInResponse.bind(this));
        con.on("copyData", this._handleCopyData.bind(this));
        con.on("notification", this._handleNotification.bind(this));
      }
      _getPassword(cb) {
        const con = this.connection;
        if (typeof this.password === "function") {
          this._Promise.resolve().then(() => this.password(this.connectionParameters)).then((pass) => {
            if (pass !== void 0) {
              if (typeof pass !== "string") {
                con.emit("error", new TypeError("Password must be a string"));
                return;
              }
              this.connectionParameters.password = this.password = pass;
            } else {
              this.connectionParameters.password = this.password = null;
            }
            cb();
          }).catch((err) => {
            con.emit("error", err);
          });
        } else if (this.password !== null) {
          cb();
        } else {
          try {
            const pgPass = require_lib();
            pgPass(this.connectionParameters, (pass) => {
              if (void 0 !== pass) {
                pgPassDeprecationNotice();
                this.connectionParameters.password = this.password = pass;
              }
              cb();
            });
          } catch (e) {
            this.emit("error", e);
          }
        }
      }
      _handleAuthCleartextPassword(msg) {
        this._getPassword(() => {
          this.connection.password(this.password);
        });
      }
      _handleAuthMD5Password(msg) {
        this._getPassword(async () => {
          try {
            const hashedPassword = await crypto2.postgresMd5PasswordHash(this.user, this.password, msg.salt);
            this.connection.password(hashedPassword);
          } catch (e) {
            this.emit("error", e);
          }
        });
      }
      _handleAuthSASL(msg) {
        this._getPassword(() => {
          try {
            this.saslSession = sasl.startSession(msg.mechanisms, this.enableChannelBinding && this.connection.stream);
            this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
          } catch (err) {
            this.connection.emit("error", err);
          }
        });
      }
      async _handleAuthSASLContinue(msg) {
        try {
          await sasl.continueSession(
            this.saslSession,
            this.password,
            msg.data,
            this.enableChannelBinding && this.connection.stream
          );
          this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleAuthSASLFinal(msg) {
        try {
          sasl.finalizeSession(this.saslSession, msg.data);
          this.saslSession = null;
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleBackendKeyData(msg) {
        this.processID = msg.processID;
        this.secretKey = msg.secretKey;
      }
      _handleReadyForQuery(msg) {
        if (this._connecting) {
          this._connecting = false;
          this._connected = true;
          clearTimeout(this.connectionTimeoutHandle);
          if (this._connectionCallback) {
            this._connectionCallback(null, this);
            this._connectionCallback = null;
          }
          this.emit("connect");
        }
        const activeQuery = this._getActiveQuery();
        this._activeQuery = null;
        this.readyForQuery = true;
        if (activeQuery) {
          activeQuery.handleReadyForQuery(this.connection);
        }
        this._pulseQueryQueue();
      }
      // if we receive an error event or error message
      // during the connection process we handle it here
      _handleErrorWhileConnecting(err) {
        if (this._connectionError) {
          return;
        }
        this._connectionError = true;
        clearTimeout(this.connectionTimeoutHandle);
        if (this._connectionCallback) {
          return this._connectionCallback(err);
        }
        this.emit("error", err);
      }
      // if we're connected and we receive an error event from the connection
      // this means the socket is dead - do a hard abort of all queries and emit
      // the socket error on the client as well
      _handleErrorEvent(err) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(err);
        }
        this._queryable = false;
        this._errorAllQueries(err);
        this.emit("error", err);
      }
      // handle error messages from the postgres backend
      _handleErrorMessage(msg) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(msg);
        }
        const activeQuery = this._getActiveQuery();
        if (!activeQuery) {
          this._handleErrorEvent(msg);
          return;
        }
        this._activeQuery = null;
        activeQuery.handleError(msg, this.connection);
      }
      _handleRowDescription(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected rowDescription message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleRowDescription(msg);
      }
      _handleDataRow(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected dataRow message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleDataRow(msg);
      }
      _handlePortalSuspended(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected portalSuspended message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handlePortalSuspended(this.connection);
      }
      _handleEmptyQuery(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected emptyQuery message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleEmptyQuery(this.connection);
      }
      _handleCommandComplete(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected commandComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCommandComplete(msg, this.connection);
      }
      _handleParseComplete() {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected parseComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        if (activeQuery.name) {
          this.connection.parsedStatements[activeQuery.name] = activeQuery.text;
        }
      }
      _handleCopyInResponse(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyInResponse message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyInResponse(this.connection);
      }
      _handleCopyData(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyData message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyData(msg, this.connection);
      }
      _handleNotification(msg) {
        this.emit("notification", msg);
      }
      _handleNotice(msg) {
        this.emit("notice", msg);
      }
      getStartupConf() {
        const params = this.connectionParameters;
        const data = {
          user: params.user,
          database: params.database
        };
        const appName = params.application_name || params.fallback_application_name;
        if (appName) {
          data.application_name = appName;
        }
        if (params.replication) {
          data.replication = "" + params.replication;
        }
        if (params.statement_timeout) {
          data.statement_timeout = String(parseInt(params.statement_timeout, 10));
        }
        if (params.lock_timeout) {
          data.lock_timeout = String(parseInt(params.lock_timeout, 10));
        }
        if (params.idle_in_transaction_session_timeout) {
          data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
        }
        if (params.options) {
          data.options = params.options;
        }
        return data;
      }
      cancel(client, query) {
        if (client.activeQuery === query) {
          const con = this.connection;
          if (this.host && this.host.indexOf("/") === 0) {
            con.connect(this.host + "/.s.PGSQL." + this.port);
          } else {
            con.connect(this.port, this.host);
          }
          con.on("connect", function() {
            con.cancel(client.processID, client.secretKey);
          });
        } else if (client._queryQueue.indexOf(query) !== -1) {
          client._queryQueue.splice(client._queryQueue.indexOf(query), 1);
        }
      }
      setTypeParser(oid, format, parseFn) {
        return this._types.setTypeParser(oid, format, parseFn);
      }
      getTypeParser(oid, format) {
        return this._types.getTypeParser(oid, format);
      }
      // escapeIdentifier and escapeLiteral moved to utility functions & exported
      // on PG
      // re-exported here for backwards compatibility
      escapeIdentifier(str) {
        return utils.escapeIdentifier(str);
      }
      escapeLiteral(str) {
        return utils.escapeLiteral(str);
      }
      _pulseQueryQueue() {
        if (this.readyForQuery === true) {
          this._activeQuery = this._queryQueue.shift();
          const activeQuery = this._getActiveQuery();
          if (activeQuery) {
            this.readyForQuery = false;
            this.hasExecuted = true;
            const queryError = activeQuery.submit(this.connection);
            if (queryError) {
              process.nextTick(() => {
                activeQuery.handleError(queryError, this.connection);
                this.readyForQuery = true;
                this._pulseQueryQueue();
              });
            }
          } else if (this.hasExecuted) {
            this._activeQuery = null;
            this.emit("drain");
          }
        }
      }
      query(config, values, callback) {
        let query;
        let result;
        let readTimeout;
        let readTimeoutTimer;
        let queryCallback;
        if (config === null || config === void 0) {
          throw new TypeError("Client was passed a null or undefined query");
        } else if (typeof config.submit === "function") {
          readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
          result = query = config;
          if (!query.callback) {
            if (typeof values === "function") {
              query.callback = values;
            } else if (callback) {
              query.callback = callback;
            }
          }
        } else {
          readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
          query = new Query2(config, values, callback);
          if (!query.callback) {
            result = new this._Promise((resolve2, reject) => {
              query.callback = (err, res) => err ? reject(err) : resolve2(res);
            }).catch((err) => {
              Error.captureStackTrace(err);
              throw err;
            });
          }
        }
        if (readTimeout) {
          queryCallback = query.callback || (() => {
          });
          readTimeoutTimer = setTimeout(() => {
            const error = new Error("Query read timeout");
            process.nextTick(() => {
              query.handleError(error, this.connection);
            });
            queryCallback(error);
            query.callback = () => {
            };
            const index = this._queryQueue.indexOf(query);
            if (index > -1) {
              this._queryQueue.splice(index, 1);
            }
            this._pulseQueryQueue();
          }, readTimeout);
          query.callback = (err, res) => {
            clearTimeout(readTimeoutTimer);
            queryCallback(err, res);
          };
        }
        if (this.binary && !query.binary) {
          query.binary = true;
        }
        if (query._result && !query._result._types) {
          query._result._types = this._types;
        }
        if (!this._queryable) {
          process.nextTick(() => {
            query.handleError(new Error("Client has encountered a connection error and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._ending) {
          process.nextTick(() => {
            query.handleError(new Error("Client was closed and is not queryable"), this.connection);
          });
          return result;
        }
        if (this._queryQueue.length > 0) {
          queryQueueLengthDeprecationNotice();
        }
        this._queryQueue.push(query);
        this._pulseQueryQueue();
        return result;
      }
      ref() {
        this.connection.ref();
      }
      unref() {
        this.connection.unref();
      }
      end(cb) {
        this._ending = true;
        if (!this.connection._connecting || this._ended) {
          if (cb) {
            cb();
          } else {
            return this._Promise.resolve();
          }
        }
        if (this._getActiveQuery() || !this._queryable) {
          this.connection.stream.destroy();
        } else {
          this.connection.end();
        }
        if (cb) {
          this.connection.once("end", cb);
        } else {
          return new this._Promise((resolve2) => {
            this.connection.once("end", resolve2);
          });
        }
      }
      get queryQueue() {
        queryQueueDeprecationNotice();
        return this._queryQueue;
      }
    };
    Client2.Query = Query2;
    module.exports = Client2;
  }
});

// node_modules/.pnpm/pg-pool@3.13.0_pg@8.20.0/node_modules/pg-pool/index.js
var require_pg_pool = __commonJS({
  "node_modules/.pnpm/pg-pool@3.13.0_pg@8.20.0/node_modules/pg-pool/index.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var NOOP = function() {
    };
    var removeWhere = (list, predicate) => {
      const i = list.findIndex(predicate);
      return i === -1 ? void 0 : list.splice(i, 1)[0];
    };
    var IdleItem = class {
      constructor(client, idleListener, timeoutId) {
        this.client = client;
        this.idleListener = idleListener;
        this.timeoutId = timeoutId;
      }
    };
    var PendingItem = class {
      constructor(callback) {
        this.callback = callback;
      }
    };
    function throwOnDoubleRelease() {
      throw new Error("Release called on client which has already been released to the pool.");
    }
    function promisify(Promise2, callback) {
      if (callback) {
        return { callback, result: void 0 };
      }
      let rej;
      let res;
      const cb = function(err, client) {
        err ? rej(err) : res(client);
      };
      const result = new Promise2(function(resolve2, reject) {
        res = resolve2;
        rej = reject;
      }).catch((err) => {
        Error.captureStackTrace(err);
        throw err;
      });
      return { callback: cb, result };
    }
    function makeIdleListener(pool, client) {
      return function idleListener(err) {
        err.client = client;
        client.removeListener("error", idleListener);
        client.on("error", () => {
          pool.log("additional client error after disconnection due to error", err);
        });
        pool._remove(client);
        pool.emit("error", err, client);
      };
    }
    var Pool3 = class extends EventEmitter {
      constructor(options, Client2) {
        super();
        this.options = Object.assign({}, options);
        if (options != null && "password" in options) {
          Object.defineProperty(this.options, "password", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: options.password
          });
        }
        if (options != null && options.ssl && options.ssl.key) {
          Object.defineProperty(this.options.ssl, "key", {
            enumerable: false
          });
        }
        this.options.max = this.options.max || this.options.poolSize || 10;
        this.options.min = this.options.min || 0;
        this.options.maxUses = this.options.maxUses || Infinity;
        this.options.allowExitOnIdle = this.options.allowExitOnIdle || false;
        this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0;
        this.log = this.options.log || function() {
        };
        this.Client = this.options.Client || Client2 || require_lib2().Client;
        this.Promise = this.options.Promise || global.Promise;
        if (typeof this.options.idleTimeoutMillis === "undefined") {
          this.options.idleTimeoutMillis = 1e4;
        }
        this._clients = [];
        this._idle = [];
        this._expired = /* @__PURE__ */ new WeakSet();
        this._pendingQueue = [];
        this._endCallback = void 0;
        this.ending = false;
        this.ended = false;
      }
      _promiseTry(f) {
        const Promise2 = this.Promise;
        if (typeof Promise2.try === "function") {
          return Promise2.try(f);
        }
        return new Promise2((resolve2) => resolve2(f()));
      }
      _isFull() {
        return this._clients.length >= this.options.max;
      }
      _isAboveMin() {
        return this._clients.length > this.options.min;
      }
      _pulseQueue() {
        this.log("pulse queue");
        if (this.ended) {
          this.log("pulse queue ended");
          return;
        }
        if (this.ending) {
          this.log("pulse queue on ending");
          if (this._idle.length) {
            this._idle.slice().map((item) => {
              this._remove(item.client);
            });
          }
          if (!this._clients.length) {
            this.ended = true;
            this._endCallback();
          }
          return;
        }
        if (!this._pendingQueue.length) {
          this.log("no queued requests");
          return;
        }
        if (!this._idle.length && this._isFull()) {
          return;
        }
        const pendingItem = this._pendingQueue.shift();
        if (this._idle.length) {
          const idleItem = this._idle.pop();
          clearTimeout(idleItem.timeoutId);
          const client = idleItem.client;
          client.ref && client.ref();
          const idleListener = idleItem.idleListener;
          return this._acquireClient(client, pendingItem, idleListener, false);
        }
        if (!this._isFull()) {
          return this.newClient(pendingItem);
        }
        throw new Error("unexpected condition");
      }
      _remove(client, callback) {
        const removed = removeWhere(this._idle, (item) => item.client === client);
        if (removed !== void 0) {
          clearTimeout(removed.timeoutId);
        }
        this._clients = this._clients.filter((c) => c !== client);
        const context = this;
        client.end(() => {
          context.emit("remove", client);
          if (typeof callback === "function") {
            callback();
          }
        });
      }
      connect(cb) {
        if (this.ending) {
          const err = new Error("Cannot use a pool after calling end on the pool");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        const response = promisify(this.Promise, cb);
        const result = response.result;
        if (this._isFull() || this._idle.length) {
          if (this._idle.length) {
            process.nextTick(() => this._pulseQueue());
          }
          if (!this.options.connectionTimeoutMillis) {
            this._pendingQueue.push(new PendingItem(response.callback));
            return result;
          }
          const queueCallback = (err, res, done) => {
            clearTimeout(tid);
            response.callback(err, res, done);
          };
          const pendingItem = new PendingItem(queueCallback);
          const tid = setTimeout(() => {
            removeWhere(this._pendingQueue, (i) => i.callback === queueCallback);
            pendingItem.timedOut = true;
            response.callback(new Error("timeout exceeded when trying to connect"));
          }, this.options.connectionTimeoutMillis);
          if (tid.unref) {
            tid.unref();
          }
          this._pendingQueue.push(pendingItem);
          return result;
        }
        this.newClient(new PendingItem(response.callback));
        return result;
      }
      newClient(pendingItem) {
        const client = new this.Client(this.options);
        this._clients.push(client);
        const idleListener = makeIdleListener(this, client);
        this.log("checking client timeout");
        let tid;
        let timeoutHit = false;
        if (this.options.connectionTimeoutMillis) {
          tid = setTimeout(() => {
            if (client.connection) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.connection.stream.destroy();
            } else if (!client.isConnected()) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.end();
            }
          }, this.options.connectionTimeoutMillis);
        }
        this.log("connecting new client");
        client.connect((err) => {
          if (tid) {
            clearTimeout(tid);
          }
          client.on("error", idleListener);
          if (err) {
            this.log("client failed to connect", err);
            this._clients = this._clients.filter((c) => c !== client);
            if (timeoutHit) {
              err = new Error("Connection terminated due to connection timeout", { cause: err });
            }
            this._pulseQueue();
            if (!pendingItem.timedOut) {
              pendingItem.callback(err, void 0, NOOP);
            }
          } else {
            this.log("new client connected");
            if (this.options.onConnect) {
              this._promiseTry(() => this.options.onConnect(client)).then(
                () => {
                  this._afterConnect(client, pendingItem, idleListener);
                },
                (hookErr) => {
                  this._clients = this._clients.filter((c) => c !== client);
                  client.end(() => {
                    this._pulseQueue();
                    if (!pendingItem.timedOut) {
                      pendingItem.callback(hookErr, void 0, NOOP);
                    }
                  });
                }
              );
              return;
            }
            return this._afterConnect(client, pendingItem, idleListener);
          }
        });
      }
      _afterConnect(client, pendingItem, idleListener) {
        if (this.options.maxLifetimeSeconds !== 0) {
          const maxLifetimeTimeout = setTimeout(() => {
            this.log("ending client due to expired lifetime");
            this._expired.add(client);
            const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client);
            if (idleIndex !== -1) {
              this._acquireClient(
                client,
                new PendingItem((err, client2, clientRelease) => clientRelease()),
                idleListener,
                false
              );
            }
          }, this.options.maxLifetimeSeconds * 1e3);
          maxLifetimeTimeout.unref();
          client.once("end", () => clearTimeout(maxLifetimeTimeout));
        }
        return this._acquireClient(client, pendingItem, idleListener, true);
      }
      // acquire a client for a pending work item
      _acquireClient(client, pendingItem, idleListener, isNew) {
        if (isNew) {
          this.emit("connect", client);
        }
        this.emit("acquire", client);
        client.release = this._releaseOnce(client, idleListener);
        client.removeListener("error", idleListener);
        if (!pendingItem.timedOut) {
          if (isNew && this.options.verify) {
            this.options.verify(client, (err) => {
              if (err) {
                client.release(err);
                return pendingItem.callback(err, void 0, NOOP);
              }
              pendingItem.callback(void 0, client, client.release);
            });
          } else {
            pendingItem.callback(void 0, client, client.release);
          }
        } else {
          if (isNew && this.options.verify) {
            this.options.verify(client, client.release);
          } else {
            client.release();
          }
        }
      }
      // returns a function that wraps _release and throws if called more than once
      _releaseOnce(client, idleListener) {
        let released = false;
        return (err) => {
          if (released) {
            throwOnDoubleRelease();
          }
          released = true;
          this._release(client, idleListener, err);
        };
      }
      // release a client back to the poll, include an error
      // to remove it from the pool
      _release(client, idleListener, err) {
        client.on("error", idleListener);
        client._poolUseCount = (client._poolUseCount || 0) + 1;
        this.emit("release", err, client);
        if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
          if (client._poolUseCount >= this.options.maxUses) {
            this.log("remove expended client");
          }
          return this._remove(client, this._pulseQueue.bind(this));
        }
        const isExpired = this._expired.has(client);
        if (isExpired) {
          this.log("remove expired client");
          this._expired.delete(client);
          return this._remove(client, this._pulseQueue.bind(this));
        }
        let tid;
        if (this.options.idleTimeoutMillis && this._isAboveMin()) {
          tid = setTimeout(() => {
            if (this._isAboveMin()) {
              this.log("remove idle client");
              this._remove(client, this._pulseQueue.bind(this));
            }
          }, this.options.idleTimeoutMillis);
          if (this.options.allowExitOnIdle) {
            tid.unref();
          }
        }
        if (this.options.allowExitOnIdle) {
          client.unref();
        }
        this._idle.push(new IdleItem(client, idleListener, tid));
        this._pulseQueue();
      }
      query(text, values, cb) {
        if (typeof text === "function") {
          const response2 = promisify(this.Promise, text);
          setImmediate(function() {
            return response2.callback(new Error("Passing a function as the first parameter to pool.query is not supported"));
          });
          return response2.result;
        }
        if (typeof values === "function") {
          cb = values;
          values = void 0;
        }
        const response = promisify(this.Promise, cb);
        cb = response.callback;
        this.connect((err, client) => {
          if (err) {
            return cb(err);
          }
          let clientReleased = false;
          const onError = (err2) => {
            if (clientReleased) {
              return;
            }
            clientReleased = true;
            client.release(err2);
            cb(err2);
          };
          client.once("error", onError);
          this.log("dispatching query");
          try {
            client.query(text, values, (err2, res) => {
              this.log("query dispatched");
              client.removeListener("error", onError);
              if (clientReleased) {
                return;
              }
              clientReleased = true;
              client.release(err2);
              if (err2) {
                return cb(err2);
              }
              return cb(void 0, res);
            });
          } catch (err2) {
            client.release(err2);
            return cb(err2);
          }
        });
        return response.result;
      }
      end(cb) {
        this.log("ending");
        if (this.ending) {
          const err = new Error("Called end on pool more than once");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        this.ending = true;
        const promised = promisify(this.Promise, cb);
        this._endCallback = promised.callback;
        this._pulseQueue();
        return promised.result;
      }
      get waitingCount() {
        return this._pendingQueue.length;
      }
      get idleCount() {
        return this._idle.length;
      }
      get expiredCount() {
        return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0);
      }
      get totalCount() {
        return this._clients.length;
      }
    };
    module.exports = Pool3;
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/native/query.js
var require_query2 = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/native/query.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var utils = require_utils();
    var NativeQuery = module.exports = function(config, values, callback) {
      EventEmitter.call(this);
      config = utils.normalizeQueryConfig(config, values, callback);
      this.text = config.text;
      this.values = config.values;
      this.name = config.name;
      this.queryMode = config.queryMode;
      this.callback = config.callback;
      this.state = "new";
      this._arrayMode = config.rowMode === "array";
      this._emitRowEvents = false;
      this.on(
        "newListener",
        function(event) {
          if (event === "row") this._emitRowEvents = true;
        }.bind(this)
      );
    };
    util.inherits(NativeQuery, EventEmitter);
    var errorFieldMap = {
      sqlState: "code",
      statementPosition: "position",
      messagePrimary: "message",
      context: "where",
      schemaName: "schema",
      tableName: "table",
      columnName: "column",
      dataTypeName: "dataType",
      constraintName: "constraint",
      sourceFile: "file",
      sourceLine: "line",
      sourceFunction: "routine"
    };
    NativeQuery.prototype.handleError = function(err) {
      const fields = this.native.pq.resultErrorFields();
      if (fields) {
        for (const key in fields) {
          const normalizedFieldName = errorFieldMap[key] || key;
          err[normalizedFieldName] = fields[key];
        }
      }
      if (this.callback) {
        this.callback(err);
      } else {
        this.emit("error", err);
      }
      this.state = "error";
    };
    NativeQuery.prototype.then = function(onSuccess, onFailure) {
      return this._getPromise().then(onSuccess, onFailure);
    };
    NativeQuery.prototype.catch = function(callback) {
      return this._getPromise().catch(callback);
    };
    NativeQuery.prototype._getPromise = function() {
      if (this._promise) return this._promise;
      this._promise = new Promise(
        function(resolve2, reject) {
          this._once("end", resolve2);
          this._once("error", reject);
        }.bind(this)
      );
      return this._promise;
    };
    NativeQuery.prototype.submit = function(client) {
      this.state = "running";
      const self = this;
      this.native = client.native;
      client.native.arrayMode = this._arrayMode;
      let after = function(err, rows, results) {
        client.native.arrayMode = false;
        setImmediate(function() {
          self.emit("_done");
        });
        if (err) {
          return self.handleError(err);
        }
        if (self._emitRowEvents) {
          if (results.length > 1) {
            rows.forEach((rowOfRows, i) => {
              rowOfRows.forEach((row) => {
                self.emit("row", row, results[i]);
              });
            });
          } else {
            rows.forEach(function(row) {
              self.emit("row", row, results);
            });
          }
        }
        self.state = "end";
        self.emit("end", results);
        if (self.callback) {
          self.callback(null, results);
        }
      };
      if (process.domain) {
        after = process.domain.bind(after);
      }
      if (this.name) {
        if (this.name.length > 63) {
          console.error("Warning! Postgres only supports 63 characters for query names.");
          console.error("You supplied %s (%s)", this.name, this.name.length);
          console.error("This can cause conflicts and silent errors executing queries");
        }
        const values = (this.values || []).map(utils.prepareValue);
        if (client.namedQueries[this.name]) {
          if (this.text && client.namedQueries[this.name] !== this.text) {
            const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
            return after(err);
          }
          return client.native.execute(this.name, values, after);
        }
        return client.native.prepare(this.name, this.text, values.length, function(err) {
          if (err) return after(err);
          client.namedQueries[self.name] = self.text;
          return self.native.execute(self.name, values, after);
        });
      } else if (this.values) {
        if (!Array.isArray(this.values)) {
          const err = new Error("Query values must be an array");
          return after(err);
        }
        const vals = this.values.map(utils.prepareValue);
        client.native.query(this.text, vals, after);
      } else if (this.queryMode === "extended") {
        client.native.query(this.text, [], after);
      } else {
        client.native.query(this.text, after);
      }
    };
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/native/client.js
var require_client2 = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/native/client.js"(exports, module) {
    var nodeUtils = __require("util");
    var Native;
    try {
      Native = __require("pg-native");
    } catch (e) {
      throw e;
    }
    var TypeOverrides2 = require_type_overrides();
    var EventEmitter = __require("events").EventEmitter;
    var util = __require("util");
    var ConnectionParameters = require_connection_parameters();
    var NativeQuery = require_query2();
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = module.exports = function(config) {
      EventEmitter.call(this);
      config = config || {};
      this._Promise = config.Promise || global.Promise;
      this._types = new TypeOverrides2(config.types);
      this.native = new Native({
        types: this._types
      });
      this._queryQueue = [];
      this._ending = false;
      this._connecting = false;
      this._connected = false;
      this._queryable = true;
      const cp = this.connectionParameters = new ConnectionParameters(config);
      if (config.nativeConnectionString) cp.nativeConnectionString = config.nativeConnectionString;
      this.user = cp.user;
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: cp.password
      });
      this.database = cp.database;
      this.host = cp.host;
      this.port = cp.port;
      this.namedQueries = {};
    };
    Client2.Query = NativeQuery;
    util.inherits(Client2, EventEmitter);
    Client2.prototype._errorAllQueries = function(err) {
      const enqueueError = (query) => {
        process.nextTick(() => {
          query.native = this.native;
          query.handleError(err);
        });
      };
      if (this._hasActiveQuery()) {
        enqueueError(this._activeQuery);
        this._activeQuery = null;
      }
      this._queryQueue.forEach(enqueueError);
      this._queryQueue.length = 0;
    };
    Client2.prototype._connect = function(cb) {
      const self = this;
      if (this._connecting) {
        process.nextTick(() => cb(new Error("Client has already been connected. You cannot reuse a client.")));
        return;
      }
      this._connecting = true;
      this.connectionParameters.getLibpqConnectionString(function(err, conString) {
        if (self.connectionParameters.nativeConnectionString) conString = self.connectionParameters.nativeConnectionString;
        if (err) return cb(err);
        self.native.connect(conString, function(err2) {
          if (err2) {
            self.native.end();
            return cb(err2);
          }
          self._connected = true;
          self.native.on("error", function(err3) {
            self._queryable = false;
            self._errorAllQueries(err3);
            self.emit("error", err3);
          });
          self.native.on("notification", function(msg) {
            self.emit("notification", {
              channel: msg.relname,
              payload: msg.extra
            });
          });
          self.emit("connect");
          self._pulseQueryQueue(true);
          cb(null, this);
        });
      });
    };
    Client2.prototype.connect = function(callback) {
      if (callback) {
        this._connect(callback);
        return;
      }
      return new this._Promise((resolve2, reject) => {
        this._connect((error) => {
          if (error) {
            reject(error);
          } else {
            resolve2(this);
          }
        });
      });
    };
    Client2.prototype.query = function(config, values, callback) {
      let query;
      let result;
      let readTimeout;
      let readTimeoutTimer;
      let queryCallback;
      if (config === null || config === void 0) {
        throw new TypeError("Client was passed a null or undefined query");
      } else if (typeof config.submit === "function") {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        result = query = config;
        if (typeof values === "function") {
          config.callback = values;
        }
      } else {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        query = new NativeQuery(config, values, callback);
        if (!query.callback) {
          let resolveOut, rejectOut;
          result = new this._Promise((resolve2, reject) => {
            resolveOut = resolve2;
            rejectOut = reject;
          }).catch((err) => {
            Error.captureStackTrace(err);
            throw err;
          });
          query.callback = (err, res) => err ? rejectOut(err) : resolveOut(res);
        }
      }
      if (readTimeout) {
        queryCallback = query.callback || (() => {
        });
        readTimeoutTimer = setTimeout(() => {
          const error = new Error("Query read timeout");
          process.nextTick(() => {
            query.handleError(error, this.connection);
          });
          queryCallback(error);
          query.callback = () => {
          };
          const index = this._queryQueue.indexOf(query);
          if (index > -1) {
            this._queryQueue.splice(index, 1);
          }
          this._pulseQueryQueue();
        }, readTimeout);
        query.callback = (err, res) => {
          clearTimeout(readTimeoutTimer);
          queryCallback(err, res);
        };
      }
      if (!this._queryable) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client has encountered a connection error and is not queryable"));
        });
        return result;
      }
      if (this._ending) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client was closed and is not queryable"));
        });
        return result;
      }
      if (this._queryQueue.length > 0) {
        queryQueueLengthDeprecationNotice();
      }
      this._queryQueue.push(query);
      this._pulseQueryQueue();
      return result;
    };
    Client2.prototype.end = function(cb) {
      const self = this;
      this._ending = true;
      if (!this._connected) {
        this.once("connect", this.end.bind(this, cb));
      }
      let result;
      if (!cb) {
        result = new this._Promise(function(resolve2, reject) {
          cb = (err) => err ? reject(err) : resolve2();
        });
      }
      this.native.end(function() {
        self._connected = false;
        self._errorAllQueries(new Error("Connection terminated"));
        process.nextTick(() => {
          self.emit("end");
          if (cb) cb();
        });
      });
      return result;
    };
    Client2.prototype._hasActiveQuery = function() {
      return this._activeQuery && this._activeQuery.state !== "error" && this._activeQuery.state !== "end";
    };
    Client2.prototype._pulseQueryQueue = function(initialConnection) {
      if (!this._connected) {
        return;
      }
      if (this._hasActiveQuery()) {
        return;
      }
      const query = this._queryQueue.shift();
      if (!query) {
        if (!initialConnection) {
          this.emit("drain");
        }
        return;
      }
      this._activeQuery = query;
      query.submit(this);
      const self = this;
      query.once("_done", function() {
        self._pulseQueryQueue();
      });
    };
    Client2.prototype.cancel = function(query) {
      if (this._activeQuery === query) {
        this.native.cancel(function() {
        });
      } else if (this._queryQueue.indexOf(query) !== -1) {
        this._queryQueue.splice(this._queryQueue.indexOf(query), 1);
      }
    };
    Client2.prototype.ref = function() {
    };
    Client2.prototype.unref = function() {
    };
    Client2.prototype.setTypeParser = function(oid, format, parseFn) {
      return this._types.setTypeParser(oid, format, parseFn);
    };
    Client2.prototype.getTypeParser = function(oid, format) {
      return this._types.getTypeParser(oid, format);
    };
    Client2.prototype.isConnected = function() {
      return this._connected;
    };
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/native/index.js
var require_native = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/native/index.js"(exports, module) {
    "use strict";
    module.exports = require_client2();
  }
});

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js
var require_lib2 = __commonJS({
  "node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js"(exports, module) {
    "use strict";
    var Client2 = require_client();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var Result2 = require_result();
    var utils = require_utils();
    var Pool3 = require_pg_pool();
    var TypeOverrides2 = require_type_overrides();
    var { DatabaseError: DatabaseError2 } = require_dist();
    var { escapeIdentifier: escapeIdentifier2, escapeLiteral: escapeLiteral2 } = require_utils();
    var poolFactory = (Client3) => {
      return class BoundPool extends Pool3 {
        constructor(options) {
          super(options, Client3);
        }
      };
    };
    var PG = function(clientConstructor2) {
      this.defaults = defaults2;
      this.Client = clientConstructor2;
      this.Query = this.Client.Query;
      this.Pool = poolFactory(this.Client);
      this._pools = [];
      this.Connection = Connection2;
      this.types = require_pg_types();
      this.DatabaseError = DatabaseError2;
      this.TypeOverrides = TypeOverrides2;
      this.escapeIdentifier = escapeIdentifier2;
      this.escapeLiteral = escapeLiteral2;
      this.Result = Result2;
      this.utils = utils;
    };
    var clientConstructor = Client2;
    var forceNative = false;
    try {
      forceNative = !!process.env.NODE_PG_FORCE_NATIVE;
    } catch {
    }
    if (forceNative) {
      clientConstructor = require_native();
    }
    module.exports = new PG(clientConstructor);
    Object.defineProperty(module.exports, "native", {
      configurable: true,
      enumerable: false,
      get() {
        let native = null;
        try {
          native = new PG(require_native());
        } catch (err) {
          if (err.code !== "MODULE_NOT_FOUND") {
            throw err;
          }
        }
        Object.defineProperty(module.exports, "native", {
          value: native
        });
        return native;
      }
    });
  }
});

// packages/mcp-servers/codebase/dist/index.js
import * as readline from "node:readline";

// node_modules/.pnpm/pg@8.20.0/node_modules/pg/esm/index.mjs
var import_lib = __toESM(require_lib2(), 1);
var Client = import_lib.default.Client;
var Pool = import_lib.default.Pool;
var Connection = import_lib.default.Connection;
var types = import_lib.default.types;
var Query = import_lib.default.Query;
var DatabaseError = import_lib.default.DatabaseError;
var escapeIdentifier = import_lib.default.escapeIdentifier;
var escapeLiteral = import_lib.default.escapeLiteral;
var Result = import_lib.default.Result;
var TypeOverrides = import_lib.default.TypeOverrides;
var defaults = import_lib.default.defaults;
var esm_default = import_lib.default;

// packages/mcp-servers/codebase/dist/pg-schema.js
var GRAPHS_DDL = `
CREATE TABLE IF NOT EXISTS codebase_graphs (
  graph_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_path TEXT        NOT NULL,
  output_dir    TEXT        NOT NULL,
  language      TEXT        NOT NULL DEFAULT 'auto',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indexed_at    TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  clustered_at  TIMESTAMPTZ,
  node_count    BIGINT      DEFAULT 0,
  edge_count    BIGINT      DEFAULT 0,
  files_indexed BIGINT      DEFAULT 0,
  elapsed_ms    BIGINT      DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_codebase_graphs_path
  ON codebase_graphs(codebase_path, output_dir);
`;
var NODES_DDL = `
CREATE TABLE IF NOT EXISTS codebase_nodes (
  id              TEXT        NOT NULL,
  graph_id        UUID        NOT NULL REFERENCES codebase_graphs(graph_id) ON DELETE CASCADE,
  label           TEXT        NOT NULL,
  name            TEXT,
  qualified_name  TEXT,
  path            TEXT,
  start_line      BIGINT,
  end_line        BIGINT,
  visibility      TEXT,
  is_async        BOOLEAN,
  receiver_type   TEXT,
  extension       TEXT,
  size_bytes      BIGINT,
  type_annotation TEXT,
  alias           TEXT,
  is_glob         BOOLEAN,
  callee_name     TEXT,
  line            BIGINT,
  col             BIGINT,
  algorithm       TEXT,
  resolution_param DOUBLE PRECISION,
  member_count    BIGINT,
  modularity_contribution DOUBLE PRECISION,
  entry_point_id  TEXT,
  entry_kind      TEXT,
  entry_confidence DOUBLE PRECISION,
  depth           BIGINT,
  symbol_count    BIGINT,
  language        TEXT,
  canonical_path  TEXT,
  PRIMARY KEY (graph_id, id)
);
CREATE INDEX IF NOT EXISTS idx_codebase_nodes_graph_label
  ON codebase_nodes(graph_id, label);
CREATE INDEX IF NOT EXISTS idx_codebase_nodes_qn
  ON codebase_nodes(graph_id, qualified_name);
CREATE INDEX IF NOT EXISTS idx_codebase_nodes_name
  ON codebase_nodes(graph_id, name);
`;
var EDGES_DDL = `
CREATE TABLE IF NOT EXISTS codebase_edges (
  edge_id           BIGSERIAL   PRIMARY KEY,
  graph_id          UUID        NOT NULL REFERENCES codebase_graphs(graph_id) ON DELETE CASCADE,
  rel_type          TEXT        NOT NULL,
  from_id           TEXT        NOT NULL,
  to_id             TEXT        NOT NULL,
  confidence        DOUBLE PRECISION,
  resolution_method TEXT,
  depth             BIGINT
);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_graph_rel
  ON codebase_edges(graph_id, rel_type);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_from
  ON codebase_edges(graph_id, from_id);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_to
  ON codebase_edges(graph_id, to_id);
CREATE INDEX IF NOT EXISTS idx_codebase_edges_from_to
  ON codebase_edges(graph_id, from_id, to_id, rel_type);
`;
var CODEBASE_SCHEMA_DDL = GRAPHS_DDL + NODES_DDL + EDGES_DDL;

// packages/mcp-servers/codebase/dist/graph-store.js
var { Pool: Pool2 } = esm_default;
var _pool = null;
function getPool() {
  if (!_pool) {
    const connStr = process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/cortex_agentic";
    _pool = new Pool2({ connectionString: connStr, max: 5 });
    _pool.on("error", (err) => {
      process.stderr.write(`codebase pg pool error: ${err.message}
`);
    });
  }
  return _pool;
}
var _schemaInitialised = false;
async function ensureSchema() {
  if (_schemaInitialised)
    return;
  const pool = getPool();
  await pool.query(CODEBASE_SCHEMA_DDL);
  _schemaInitialised = true;
}
var GraphStore = class _GraphStore {
  graphId;
  constructor(graphId) {
    this.graphId = graphId;
  }
  // ── Graph record management ───────────────────────────────────────────────
  static async create(codebasePath, outputDir, language) {
    await ensureSchema();
    const pool = getPool();
    const res = await pool.query(`INSERT INTO codebase_graphs (codebase_path, output_dir, language)
       VALUES ($1, $2, $3) RETURNING graph_id`, [codebasePath, outputDir, language]);
    const row = res.rows[0];
    if (!row)
      throw new Error("GraphStore.create: no row returned");
    return new _GraphStore(row.graph_id);
  }
  /**
   * Finds the most-recent graph for a given output_dir, or creates a new one.
   * source: graph_store.rs:133-151 — open_or_create()
   */
  static async openOrCreate(codebasePath, outputDir, language = "auto") {
    await ensureSchema();
    const pool = getPool();
    const res = await pool.query(`SELECT graph_id FROM codebase_graphs
       WHERE output_dir = $1
       ORDER BY created_at DESC LIMIT 1`, [outputDir]);
    if (res.rows[0]) {
      return new _GraphStore(res.rows[0].graph_id);
    }
    return _GraphStore.create(codebasePath, outputDir, language);
  }
  /** Resolves graph_id from a graph path (output_dir or graph_id string). */
  static async fromGraphPath(graphPath) {
    await ensureSchema();
    const pool = getPool();
    if (/^[0-9a-f-]{36}$/.test(graphPath)) {
      const r = await pool.query("SELECT graph_id FROM codebase_graphs WHERE graph_id = $1", [graphPath]);
      if (r.rows[0])
        return new _GraphStore(r.rows[0].graph_id);
    }
    const r2 = await pool.query(`SELECT graph_id FROM codebase_graphs
       WHERE output_dir = $1 OR output_dir LIKE $2
       ORDER BY created_at DESC LIMIT 1`, [graphPath, graphPath + "%"]);
    if (r2.rows[0])
      return new _GraphStore(r2.rows[0].graph_id);
    throw new Error(`GraphStore.fromGraphPath: no graph found for path ${graphPath}`);
  }
  async getRecord() {
    const pool = getPool();
    const r = await pool.query("SELECT * FROM codebase_graphs WHERE graph_id = $1", [this.graphId]);
    const row = r.rows[0];
    if (!row)
      throw new Error(`GraphStore: graph_id ${this.graphId} not found`);
    return row;
  }
  async updatePhase(phase, stats) {
    const pool = getPool();
    const col = `${phase}_at`;
    let sql = `UPDATE codebase_graphs SET ${col} = NOW()`;
    const params = [this.graphId];
    let idx = 2;
    if (stats) {
      for (const [k, v] of Object.entries(stats)) {
        if (v !== void 0) {
          sql += `, ${k} = $${idx++}`;
          params.push(v);
        }
      }
    }
    sql += ` WHERE graph_id = $1`;
    await pool.query(sql, params);
  }
  // ── Node operations ───────────────────────────────────────────────────────
  /**
   * Inserts or upserts a single node.
   * source: graph_store.rs:164-175 — insert_node()
   */
  async insertNode(label, props) {
    const pool = getPool();
    const allProps = { ...props, label, graph_id: this.graphId };
    const cols = Object.keys(allProps);
    const vals = Object.values(allProps);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const setClauses = cols.filter((c) => c !== "id" && c !== "graph_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    await pool.query(`INSERT INTO codebase_nodes (${cols.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (graph_id, id) DO UPDATE SET ${setClauses}`, vals);
  }
  /**
   * Bulk-inserts nodes of the same label.
   * source: graph_store.rs:195-215 — bulk_insert_nodes()
   * Uses a single multi-row INSERT for performance.
   * source: graph_store.rs:94 — BULK_BATCH_SIZE = 500
   */
  async bulkInsertNodes(label, rows) {
    if (rows.length === 0)
      return 0;
    const BATCH = 500;
    const pool = getPool();
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const colSet = /* @__PURE__ */ new Set(["id", "graph_id", "label"]);
      for (const row of chunk) {
        for (const k of Object.keys(row))
          colSet.add(k);
      }
      const cols = Array.from(colSet);
      const vals = [];
      const rowPlaceholders = [];
      for (const row of chunk) {
        const ph = [];
        for (const col of cols) {
          if (col === "graph_id") {
            ph.push(`$${vals.length + 1}`);
            vals.push(this.graphId);
          } else if (col === "label") {
            ph.push(`$${vals.length + 1}`);
            vals.push(label);
          } else {
            ph.push(`$${vals.length + 1}`);
            vals.push(row[col] ?? null);
          }
        }
        rowPlaceholders.push(`(${ph.join(", ")})`);
      }
      const setClauses = cols.filter((c) => c !== "id" && c !== "graph_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ");
      await pool.query(`INSERT INTO codebase_nodes (${cols.join(", ")})
         VALUES ${rowPlaceholders.join(", ")}
         ON CONFLICT (graph_id, id) DO UPDATE SET ${setClauses}`, vals);
      inserted += chunk.length;
    }
    return inserted;
  }
  /**
   * Inserts a single directed edge.
   * source: graph_store.rs:253-276 — insert_edge()
   */
  async insertEdge(relType, fromId, toId, props = {}) {
    const pool = getPool();
    const confidence = props["confidence"] ?? null;
    const resMethod = props["resolution_method"] ?? null;
    const depthVal = props["depth"] ?? null;
    await pool.query(`INSERT INTO codebase_edges (graph_id, rel_type, from_id, to_id, confidence, resolution_method, depth)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, [this.graphId, relType, fromId, toId, confidence, resMethod, depthVal]);
  }
  /**
   * Bulk-inserts edges of the same type.
   * source: graph_store.rs:229-251 — bulk_insert_edges()
   */
  async bulkInsertEdges(relType, edges) {
    if (edges.length === 0)
      return 0;
    const BATCH = 500;
    const pool = getPool();
    let inserted = 0;
    for (let i = 0; i < edges.length; i += BATCH) {
      const chunk = edges.slice(i, i + BATCH);
      const vals = [];
      const ph = [];
      for (const e of chunk) {
        const base = vals.length;
        vals.push(this.graphId, relType, e.from, e.to, e.props?.["confidence"] ?? null, e.props?.["resolution_method"] ?? null, e.props?.["depth"] ?? null);
        const [p1, p2, p3, p4, p5, p6, p7] = [base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7];
        ph.push(`($${p1},$${p2},$${p3},$${p4},$${p5},$${p6},$${p7})`);
      }
      await pool.query(`INSERT INTO codebase_edges
         (graph_id, rel_type, from_id, to_id, confidence, resolution_method, depth)
         VALUES ${ph.join(",")}`, vals);
      inserted += chunk.length;
    }
    return inserted;
  }
  // ── Query operations ──────────────────────────────────────────────────────
  /**
   * Executes an arbitrary SQL query returning rows.
   * NOTE: This is NOT Cypher. The query_graph MCP tool accepts Cypher-like
   * syntax and we translate common patterns to SQL.
   * source: graph_store.rs:279-287 — execute_query()
   */
  async executeQuery(sql, params = []) {
    const pool = getPool();
    const r = await pool.query(sql, params);
    const columns = r.fields.map((f) => f.name);
    const rows = r.rows.map((row) => r.fields.map((f) => {
      const v = row[f.name];
      return v === null || v === void 0 ? "" : String(v);
    }));
    return { columns, rows };
  }
  /**
   * Returns the total number of nodes across all labels.
   * source: graph_store.rs:290-304 — node_count()
   */
  async nodeCount() {
    const pool = getPool();
    const r = await pool.query("SELECT COUNT(*)::text AS count FROM codebase_nodes WHERE graph_id = $1", [this.graphId]);
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }
  /**
   * Returns the total number of edges.
   * source: graph_store.rs:307-321 — edge_count()
   */
  async edgeCount() {
    const pool = getPool();
    const r = await pool.query("SELECT COUNT(*)::text AS count FROM codebase_edges WHERE graph_id = $1", [this.graphId]);
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }
  /** Returns nodes of a label. */
  async nodesOfLabel(label) {
    const pool = getPool();
    const r = await pool.query("SELECT * FROM codebase_nodes WHERE graph_id = $1 AND label = $2", [this.graphId, label]);
    return r.rows;
  }
  /** Returns all edges of a rel_type. */
  async edgesOfType(relType) {
    const pool = getPool();
    const r = await pool.query(`SELECT from_id, to_id, confidence, resolution_method, depth
       FROM codebase_edges WHERE graph_id = $1 AND rel_type = $2`, [this.graphId, relType]);
    return r.rows;
  }
  /** Looks up a node by qualified_name (or id) across all labels. */
  async findNode(qualifiedName) {
    const pool = getPool();
    const r = await pool.query(`SELECT * FROM codebase_nodes
       WHERE graph_id = $1 AND (qualified_name = $2 OR id = $2)
       LIMIT 1`, [this.graphId, qualifiedName]);
    return r.rows[0] ?? null;
  }
  /** Looks up a node by id. */
  async findNodeById(id) {
    const pool = getPool();
    const r = await pool.query("SELECT * FROM codebase_nodes WHERE graph_id = $1 AND id = $2 LIMIT 1", [this.graphId, id]);
    return r.rows[0] ?? null;
  }
  /** Returns outgoing edges from a node id. */
  async outEdges(nodeId) {
    const pool = getPool();
    const r = await pool.query(`SELECT rel_type, to_id, confidence, resolution_method
       FROM codebase_edges WHERE graph_id = $1 AND from_id = $2`, [this.graphId, nodeId]);
    return r.rows;
  }
  /** Returns incoming edges to a node id. */
  async inEdges(nodeId) {
    const pool = getPool();
    const r = await pool.query(`SELECT rel_type, from_id, confidence, resolution_method
       FROM codebase_edges WHERE graph_id = $1 AND to_id = $2`, [this.graphId, nodeId]);
    return r.rows;
  }
  /** Deletes all data for this graph. */
  async drop() {
    const pool = getPool();
    await pool.query("DELETE FROM codebase_graphs WHERE graph_id = $1", [this.graphId]);
  }
};
function cypherToSql(cypher, graphId) {
  const clean = cypher.trim();
  const countMatch = clean.match(/^MATCH\s*\(n:(\w+)\)\s*RETURN\s*count\(n\)$/i);
  if (countMatch) {
    const label = countMatch[1];
    return {
      sql: 'SELECT COUNT(*) AS "count(n)" FROM codebase_nodes WHERE graph_id = $1 AND label = $2',
      params: [graphId, label]
    };
  }
  const simpleMatch = clean.match(/^MATCH\s*\(n:(\w+)\)\s*(?:WHERE\s+(.+?))?\s*RETURN\s+(.+?)(?:\s+LIMIT\s+(\d+))?$/is);
  if (simpleMatch) {
    const label = simpleMatch[1] ?? "";
    const whereClause = simpleMatch[2];
    const returnClause = simpleMatch[3] ?? "";
    const limit = simpleMatch[4];
    const params = [graphId, label];
    let sql = `SELECT ${buildSelectCols(returnClause, "n")} FROM codebase_nodes n WHERE graph_id = $1 AND label = $2`;
    if (whereClause) {
      const { clause, addedParams } = translateWhere(whereClause, "n", params.length);
      sql += ` AND ${clause}`;
      params.push(...addedParams);
    }
    if (limit)
      sql += ` LIMIT ${parseInt(limit, 10)}`;
    return { sql, params };
  }
  const edgeMatch = clean.match(/^MATCH\s*\(a:(\w+)\)-\[:(\w+)\]->\(b:(\w+)\)\s*(?:WHERE\s+(.+?))?\s*RETURN\s+(.+?)(?:\s+LIMIT\s+(\d+))?$/is);
  if (edgeMatch) {
    const fromLabel = edgeMatch[1] ?? "";
    const relType = edgeMatch[2] ?? "";
    const toLabel = edgeMatch[3] ?? "";
    const whereClause = edgeMatch[4];
    const returnClause = edgeMatch[5] ?? "";
    const limit = edgeMatch[6];
    const params = [graphId, relType, fromLabel, toLabel];
    let sql = `
      SELECT ${buildSelectCols(returnClause, "a", "b")}
      FROM codebase_edges e
      JOIN codebase_nodes a ON a.graph_id = e.graph_id AND a.id = e.from_id AND a.label = $3
      JOIN codebase_nodes b ON b.graph_id = e.graph_id AND b.id = e.to_id AND b.label = $4
      WHERE e.graph_id = $1 AND e.rel_type = $2`;
    if (whereClause) {
      const { clause, addedParams } = translateWhere(whereClause, "a", params.length, "b");
      sql += ` AND ${clause}`;
      params.push(...addedParams);
    }
    if (limit)
      sql += ` LIMIT ${parseInt(limit, 10)}`;
    return { sql, params };
  }
  return null;
}
function buildSelectCols(returnClause, ..._aliases) {
  const parts = returnClause.split(",").map((p) => {
    const t = p.trim();
    if (t.match(/^\w+\.\w+$/))
      return `${t} AS "${t}"`;
    if (t.match(/^count\(\w+\)$/i))
      return `COUNT(*) AS "${t}"`;
    return t;
  });
  return parts.join(", ");
}
function translateWhere(where, primaryAlias, paramOffset, secondaryAlias) {
  const params = [];
  let pIdx = paramOffset + 1;
  let clause = where;
  clause = clause.replace(/(\w+)\.(\w+)\s*=\s*'((?:[^'\\]|\\.)*)'/g, (_m, alias, prop, val) => {
    params.push(val.replace(/\\'/g, "'").replace(/\\\\/g, "\\"));
    return `${alias}.${prop} = $${pIdx++}`;
  });
  void primaryAlias;
  void secondaryAlias;
  return { clause, addedParams: params };
}

// packages/mcp-servers/codebase/dist/indexer.js
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// packages/mcp-servers/codebase/dist/parser.js
import * as fs from "node:fs";
import * as path from "node:path";

// packages/mcp-servers/codebase/dist/parser-lang.js
function normalizeFilePath(filePath) {
  return filePath;
}
function extractCallsFromBlock(lines, start, end, fromQn, refs) {
  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i] ?? "";
    const callRegex = /\b(\w+)\s*\(/g;
    let m;
    while ((m = callRegex.exec(line)) !== null) {
      const callee = m[1];
      if (!callee)
        continue;
      if ([
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "function",
        "class",
        "return",
        "typeof",
        "instanceof",
        "new",
        "await",
        "yield"
      ].includes(callee))
        continue;
      refs.push({ from_id: fromQn, to_path: callee, kind: "call" });
    }
  }
}
function parsePython(source, filePath) {
  const nodes = [];
  const refs = [];
  const lines = source.split("\n");
  const fileId = normalizeFilePath(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;
    const importFrom = line.match(/^from\s+(\S+)\s+import\s+(.+)/);
    if (importFrom) {
      refs.push({ from_id: fileId, to_path: importFrom[1] ?? "", kind: "import" });
      i++;
      continue;
    }
    const importDirect = line.match(/^import\s+(\S+)/);
    if (importDirect) {
      refs.push({ from_id: fileId, to_path: importDirect[1] ?? "", kind: "import" });
      i++;
      continue;
    }
    const indentLevel = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const funcMatch = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (funcMatch) {
      const name = funcMatch[2] ?? "";
      const isAsync = line.includes("async ");
      const endLine = findPythonBlockEnd(lines, i, indentLevel);
      const qn = `${fileId}::${name}`;
      const label = indentLevel > 0 ? "Method" : "Function";
      nodes.push({
        id: qn,
        label,
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: name.startsWith("_") ? "private" : "pub",
        is_async: isAsync
      });
      extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
      i++;
      continue;
    }
    const classMatch = line.match(/^(\s*)class\s+(\w+)(?:\s*\(([^)]*)\))?/);
    if (classMatch && (classMatch[1]?.length ?? 0) === 0) {
      const name = classMatch[2] ?? "";
      const bases = classMatch[3];
      const endLine = findPythonBlockEnd(lines, i, 0);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Struct",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: name.startsWith("_") ? "private" : "pub",
        is_async: false
      });
      if (bases) {
        for (const b of bases.split(",")) {
          const t = b.trim();
          if (t && t !== "object")
            refs.push({ from_id: qn, to_path: t, kind: "extends" });
        }
      }
      i++;
      continue;
    }
  }
  return { nodes, refs };
}
function findPythonBlockEnd(lines, start, baseIndent) {
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "")
      continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= baseIndent)
      return i;
  }
  return lines.length;
}
function parseRust(source, filePath) {
  const nodes = [];
  const refs = [];
  const lines = source.split("\n");
  const fileId = normalizeFilePath(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;
    const useMatch = line.match(/^\s*(?:pub\s+)?use\s+([^;]+);/);
    if (useMatch) {
      const usePath = useMatch[1]?.trim() ?? "";
      const isGlob = usePath.endsWith("::*");
      const importId = `${fileId}::import::${usePath.replace(/\W/g, "_")}::${lineNum}`;
      nodes.push({
        id: importId,
        label: "Import",
        name: usePath,
        qualified_name: importId,
        start_line: lineNum,
        end_line: lineNum,
        visibility: line.includes("pub use") ? "pub" : "",
        is_async: false,
        is_glob: isGlob
      });
      refs.push({ from_id: fileId, to_path: usePath, kind: "import" });
      continue;
    }
    const vis = line.includes("pub ") ? "pub" : line.includes("pub(crate)") ? "pub(crate)" : "";
    const funcMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*)?\s*\(/);
    if (funcMatch) {
      const name = funcMatch[1] ?? "";
      const isAsync = line.includes("async ");
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Function",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: vis,
        is_async: isAsync
      });
      extractCallsFromBlock(lines, i, endLine - 1, qn, refs);
      i++;
      continue;
    }
    const structMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?\s*[{(;]/);
    if (structMatch) {
      const name = structMatch[1] ?? "";
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Struct",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: vis,
        is_async: false
      });
      i++;
      continue;
    }
    const enumMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)(?:<[^>]*>)?\s*\{/);
    if (enumMatch) {
      const name = enumMatch[1] ?? "";
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Enum",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: vis,
        is_async: false
      });
      i++;
      continue;
    }
    const traitMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?\s*(?::\s*[^{]+)?\s*\{/);
    if (traitMatch) {
      const name = traitMatch[1] ?? "";
      const endLine = findRustBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Trait",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: vis,
        is_async: false
      });
      i++;
      continue;
    }
    const typeMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=\s*([^;]+);/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "";
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "TypeAlias",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: lineNum,
        visibility: vis,
        is_async: false,
        type_annotation: typeMatch[2]?.trim()
      });
      continue;
    }
    const constMatch = line.match(/(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)(?::\s*([^=]+))?\s*=/);
    if (constMatch) {
      const name = constMatch[1] ?? "";
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Constant",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: lineNum,
        visibility: vis,
        is_async: false,
        type_annotation: constMatch[2]?.trim()
      });
      continue;
    }
  }
  return { nodes, refs };
}
function findRustBlockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{")
        depth++;
      else if (ch === "}") {
        depth--;
        if (depth <= 0)
          return i + 1;
      }
    }
  }
  return lines.length;
}

// packages/mcp-servers/codebase/dist/parser.js
function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "swift":
      return "swift";
    case "m":
    case "mm":
      return "objc";
    case "c":
    case "h":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return "cpp";
    case "go":
      return "go";
    default:
      return "unknown";
  }
}
var MAX_FILES = 1e5;
var MAX_FILE_BYTES = 10485760;
var MAX_PARSE_BYTES = 1048576;
var MAX_DEPTH = 64;
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  "target",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".tox",
  "venv",
  ".venv",
  "vendor",
  ".cargo"
]);
function collectSourceFiles(root, languageFilter) {
  const results = [];
  walkDir(root, results, languageFilter, 0);
  if (results.length > MAX_FILES) {
    throw new Error(`too_many_files: codebase contains ${results.length} files, MAX_FILES is ${MAX_FILES}`);
  }
  results.sort();
  return results;
}
function walkDir(dir, out, languageFilter, depth) {
  if (depth > MAX_DEPTH)
    return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") && depth > 0)
      continue;
    if (SKIP_DIRS.has(name))
      continue;
    const fullPath = path.join(dir, name);
    if (entry.isSymbolicLink())
      continue;
    if (entry.isDirectory()) {
      walkDir(fullPath, out, languageFilter, depth + 1);
      if (out.length > MAX_FILES)
        return;
    } else if (entry.isFile()) {
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES)
        continue;
      const lang = detectLanguage(fullPath);
      if (lang === "unknown")
        continue;
      if (languageFilter && lang !== languageFilter)
        continue;
      out.push(fullPath);
    }
  }
}
function parseFile(filePath, source) {
  const lang = detectLanguage(filePath);
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseTypeScript(source, filePath);
    case "python":
      return parsePython(source, filePath);
    case "rust":
      return parseRust(source, filePath);
    default:
      return { nodes: [], refs: [] };
  }
}
function parseTypeScript(source, filePath) {
  const nodes = [];
  const refs = [];
  const lines = source.split("\n");
  const fileId = normalizeFilePath2(filePath);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;
    const importMatch = line.match(/^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const importPath = importMatch[1] ?? "";
      const importId = `${fileId}::import::${importPath.replace(/\W/g, "_")}::${lineNum}`;
      nodes.push({
        id: importId,
        label: "Import",
        name: importPath,
        qualified_name: importId,
        start_line: lineNum,
        end_line: lineNum,
        visibility: "",
        is_async: false,
        is_glob: line.includes("* as")
      });
      refs.push({ from_id: fileId, to_path: importPath, kind: "import" });
      i++;
      continue;
    }
    const sideImport = line.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideImport) {
      refs.push({ from_id: fileId, to_path: sideImport[1] ?? "", kind: "import" });
      i++;
      continue;
    }
    const isExported = line.includes("export ");
    const asyncFlag = line.includes("async ");
    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*[(<]/);
    if (funcMatch && !line.includes("=>")) {
      const name = funcMatch[1] ?? "";
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Function",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: isExported ? "export" : "",
        is_async: asyncFlag
      });
      extractCallsFromBlock2(lines, i, endLine - 1, qn, refs);
      i = endLine;
      continue;
    }
    const arrowConst = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?\(/);
    if (arrowConst && (line.includes("=>") || lookAheadForArrow(lines, i))) {
      const name = arrowConst[1] ?? "";
      const asyncA = line.includes("async ");
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Function",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: asyncA
      });
      extractCallsFromBlock2(lines, i, endLine - 1, qn, refs);
      i = endLine;
      continue;
    }
    const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/);
    if (classMatch) {
      const name = classMatch[1] ?? "";
      const extendsName = classMatch[2];
      const implementsStr = classMatch[3];
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Struct",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false
      });
      if (extendsName)
        refs.push({ from_id: qn, to_path: extendsName, kind: "extends" });
      if (implementsStr) {
        for (const impl of implementsStr.split(",")) {
          const t = impl.trim().split("<")[0]?.trim();
          if (t)
            refs.push({ from_id: qn, to_path: t, kind: "implements" });
        }
      }
      extractClassMethods(lines, i, endLine - 1, qn, nodes, refs);
      i = endLine;
      continue;
    }
    const ifaceMatch = line.match(/(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?/);
    if (ifaceMatch) {
      const name = ifaceMatch[1] ?? "";
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Trait",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false
      });
      const extendsStr = ifaceMatch[2];
      if (extendsStr) {
        for (const e of extendsStr.split(",")) {
          const t = e.trim().split("<")[0]?.trim();
          if (t)
            refs.push({ from_id: qn, to_path: t, kind: "extends" });
        }
      }
      i = endLine;
      continue;
    }
    const enumMatch = line.match(/(?:export\s+)?(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      const name = enumMatch[1] ?? "";
      const endLine = findBlockEnd(lines, i);
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "Enum",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: endLine,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false
      });
      i = endLine;
      continue;
    }
    const typeMatch = line.match(/(?:export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/);
    if (typeMatch) {
      const name = typeMatch[1] ?? "";
      const qn = `${fileId}::${name}`;
      nodes.push({
        id: qn,
        label: "TypeAlias",
        name,
        qualified_name: qn,
        start_line: lineNum,
        end_line: lineNum,
        visibility: line.includes("export ") ? "export" : "",
        is_async: false
      });
      i++;
      continue;
    }
    i++;
  }
  return { nodes, refs };
}
function lookAheadForArrow(lines, startIdx) {
  const LOOKAHEAD_LINES = 5;
  for (let j = startIdx; j < Math.min(startIdx + LOOKAHEAD_LINES, lines.length); j++) {
    if ((lines[j] ?? "").includes("=>"))
      return true;
  }
  return false;
}
function extractClassMethods(lines, classStart, classEnd, classQn, nodes, refs) {
  for (let i = classStart + 1; i <= classEnd; i++) {
    const line = lines[i] ?? "";
    const methodMatch = line.match(/^\s*(?:(public|private|protected|static|async|override|readonly)\s+)*(?:async\s+)?(\w+)\s*(?:<[^>]*)?\s*\(/);
    if (!methodMatch)
      continue;
    const name = methodMatch[2];
    if (!name || name === "if" || name === "for" || name === "while" || name === "switch" || name === "catch" || name === "return")
      continue;
    const isAsync = line.includes("async ");
    const vis = line.includes("private ") ? "private" : line.includes("protected ") ? "protected" : "public";
    const endLine = findBlockEnd(lines, i);
    const qn = `${classQn}::${name}`;
    nodes.push({
      id: qn,
      label: "Method",
      name,
      qualified_name: qn,
      start_line: i + 1,
      end_line: endLine,
      visibility: vis,
      is_async: isAsync,
      receiver_type: classQn.split("::").pop() ?? ""
    });
    extractCallsFromBlock2(lines, i, endLine - 1, qn, refs);
    i = endLine - 1;
  }
}
function extractCallsFromBlock2(lines, start, end, fromQn, refs) {
  for (let i = start; i <= end && i < lines.length; i++) {
    const line = lines[i] ?? "";
    const callRegex = /\b(\w+)\s*\(/g;
    let m;
    while ((m = callRegex.exec(line)) !== null) {
      const callee = m[1];
      if (!callee)
        continue;
      if ([
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "function",
        "class",
        "return",
        "typeof",
        "instanceof",
        "new",
        "await",
        "yield"
      ].includes(callee))
        continue;
      refs.push({ from_id: fromQn, to_path: callee, kind: "call" });
    }
  }
}
function findBlockEnd(lines, start) {
  let depth = 0;
  let found = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const stripped = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""');
    for (const ch of stripped) {
      if (ch === "{") {
        depth++;
        found = true;
      } else if (ch === "}" && found) {
        depth--;
        if (depth <= 0)
          return i + 1;
      }
    }
    if (!found && line.includes("=>") && (line.includes(";") || i > start && lines[i]?.trimEnd().endsWith(";"))) {
      return i + 1;
    }
  }
  return start + 1;
}
function normalizeFilePath2(filePath) {
  return filePath;
}

// packages/mcp-servers/codebase/dist/indexer.js
async function indexCodebase(codebasePath, outputDir, languageFilter) {
  const startMs = Date.now();
  const absCodebase = path2.resolve(codebasePath);
  const absOutput = path2.resolve(outputDir);
  if (!fs2.existsSync(absCodebase)) {
    throw new Error(`codebase path does not exist: ${absCodebase}`);
  }
  const store = await GraphStore.create(absCodebase, absOutput, languageFilter ?? "auto");
  const sourceFiles = collectSourceFiles(absCodebase, languageFilter);
  let filesIndexed = 0;
  const dirNodesInserted = /* @__PURE__ */ new Set();
  for (const filePath of sourceFiles) {
    const relPath = path2.relative(absCodebase, filePath);
    const fileSize = (() => {
      try {
        return fs2.statSync(filePath).size;
      } catch {
        return 0;
      }
    })();
    const ext = path2.extname(filePath).slice(1);
    const fileName = path2.basename(filePath);
    const parts = relPath.split(path2.sep);
    let dirAcc = "";
    for (let d = 0; d < parts.length - 1; d++) {
      const part = parts[d];
      if (!part)
        continue;
      dirAcc = dirAcc ? path2.join(dirAcc, part) : part;
      if (!dirNodesInserted.has(dirAcc)) {
        dirNodesInserted.add(dirAcc);
        await store.insertNode("Directory", {
          id: dirAcc,
          path: dirAcc,
          name: path2.basename(dirAcc)
        });
        if (d > 0) {
          const parentDir = parts.slice(0, d).join(path2.sep);
          await store.insertEdge("Contains_Dir_Dir", parentDir, dirAcc);
        }
      }
    }
    await store.insertNode("File", {
      id: relPath,
      path: relPath,
      name: fileName,
      extension: ext,
      size_bytes: fileSize
    });
    if (parts.length > 1) {
      const parentDir = parts.slice(0, parts.length - 1).join(path2.sep);
      await store.insertEdge("Contains_Dir_File", parentDir, relPath);
    }
    let source;
    try {
      const raw = fs2.readFileSync(filePath);
      if (raw.length > MAX_PARSE_BYTES) {
        process.stderr.write(`indexer: skipping oversized file (parse limit): ${relPath}
`);
        continue;
      }
      source = raw.toString("utf8");
    } catch (e) {
      process.stderr.write(`indexer: failed to read ${relPath}: ${e}
`);
      continue;
    }
    try {
      await indexSingleFile(store, source, relPath);
      filesIndexed++;
    } catch (e) {
      process.stderr.write(`indexer: error indexing ${relPath}: ${e}
`);
    }
  }
  const nodeCount = await store.nodeCount();
  const edgeCount = await store.edgeCount();
  const elapsedMs = Date.now() - startMs;
  await store.updatePhase("indexed", { node_count: nodeCount, edge_count: edgeCount, files_indexed: filesIndexed, elapsed_ms: elapsedMs });
  return {
    graphId: store.graphId,
    graphPath: absOutput,
    nodeCount,
    edgeCount,
    filesIndexed,
    elapsedMs
  };
}
async function indexSingleFile(store, source, relPath) {
  const parsed = parseFile(relPath, source);
  if (parsed.nodes.length === 0 && parsed.refs.length === 0)
    return;
  const nodesByLabel = /* @__PURE__ */ new Map();
  for (const node of parsed.nodes) {
    const bucket = nodesByLabel.get(node.label) ?? [];
    bucket.push({
      id: node.id,
      name: node.name,
      qualified_name: node.qualified_name,
      path: relPath,
      start_line: node.start_line ?? null,
      end_line: node.end_line ?? null,
      visibility: node.visibility ?? null,
      is_async: node.is_async ?? null,
      receiver_type: node.receiver_type ?? null,
      type_annotation: node.type_annotation ?? null,
      alias: node.alias ?? null,
      is_glob: node.is_glob ?? null,
      callee_name: node.callee_name ?? null,
      line: node.line ?? null,
      col: node.col ?? null
    });
    nodesByLabel.set(node.label, bucket);
  }
  for (const [label, rows] of nodesByLabel) {
    await store.bulkInsertNodes(label, rows);
  }
  for (const node of parsed.nodes) {
    if (node.label === "Import") {
      await store.insertEdge("Defines_File_Import", relPath, node.id);
    } else if (node.label === "Function") {
      await store.insertEdge("Defines_File_Function", relPath, node.id);
    } else if (node.label === "Struct") {
      await store.insertEdge("Defines_File_Struct", relPath, node.id);
    } else if (node.label === "Enum") {
      await store.insertEdge("Defines_File_Enum", relPath, node.id);
    } else if (node.label === "Trait") {
      await store.insertEdge("Defines_File_Trait", relPath, node.id);
    } else if (node.label === "Constant") {
      await store.insertEdge("Defines_File_Constant", relPath, node.id);
    } else if (node.label === "TypeAlias") {
      await store.insertEdge("Defines_File_TypeAlias", relPath, node.id);
    }
  }
  const callSites = [];
  for (const ref of parsed.refs) {
    if (ref.kind === "call") {
      const csId = `${ref.from_id}::callsite::${ref.to_path}`;
      callSites.push({
        id: csId,
        callee_name: ref.to_path,
        line: 0,
        col: 0,
        // Store from_id and kind as extra info for resolver
        name: ref.from_id,
        qualified_name: `${ref.from_id}::${ref.to_path}`
      });
    }
  }
  if (callSites.length > 0) {
    await store.bulkInsertNodes("CallSite", callSites);
  }
}

// packages/mcp-servers/codebase/dist/resolver.js
var CONFIDENCE_STATIC_IMPORT = 0.9;
var CONFIDENCE_CALL_NAME_MATCH = 0.7;
async function buildSymbolIndex(store) {
  const labels = [
    "Function",
    "Method",
    "Struct",
    "Enum",
    "Trait",
    "Constant",
    "TypeAlias",
    "Module",
    "File"
  ];
  const byName = /* @__PURE__ */ new Map();
  const byQn = /* @__PURE__ */ new Map();
  for (const label of labels) {
    const qnCol = label === "File" ? "path" : "qualified_name";
    const nameCol = "name";
    const nodes = await (async () => {
      try {
        const pool = store;
        void pool;
        return await store.nodesOfLabel(label);
      } catch {
        return [];
      }
    })();
    for (const node of nodes) {
      const id = String(node["id"] ?? "");
      const name = String(node[nameCol] ?? node["name"] ?? "");
      const qn = String(node[qnCol] ?? node["qualified_name"] ?? id);
      if (!id)
        continue;
      const entry = { id, label, qualified_name: qn };
      if (!byName.has(name))
        byName.set(name, []);
      (byName.get(name) ?? []).push(entry);
      byQn.set(qn, entry);
      if (id !== qn)
        byQn.set(id, entry);
    }
  }
  return { byName, byQn };
}
async function resolveGraph(store) {
  const startMs = Date.now();
  const result = {
    importsResolved: 0,
    callsResolved: 0,
    implsResolved: 0,
    extendsResolved: 0,
    usesResolved: 0,
    totalEdges: 0,
    totalRefs: 0,
    unresolved: [],
    elapsedMs: 0
  };
  const index = await buildSymbolIndex(store);
  await resolveImports(store, index, result);
  await resolveCalls(store, index, result);
  await resolveStructuralRefs(store, index, result);
  result.totalEdges = result.importsResolved + result.callsResolved + result.implsResolved + result.extendsResolved + result.usesResolved;
  result.elapsedMs = Date.now() - startMs;
  await store.updatePhase("resolved");
  return result;
}
async function resolveImports(store, index, result) {
  const importNodes = await store.nodesOfLabel("Import");
  result.totalRefs += importNodes.length;
  for (const importNode of importNodes) {
    const importId = String(importNode["id"] ?? "");
    const importPath = String(importNode["name"] ?? "");
    if (!importId || !importPath)
      continue;
    const parentEdges = await store.inEdges(importId);
    const parentFileId = parentEdges.find((e) => e.rel_type === "Defines_File_Import")?.from_id;
    if (!parentFileId)
      continue;
    const targetEntry = resolveImportPath(importPath, parentFileId, index);
    if (!targetEntry) {
      result.unresolved.push({
        kind: "import",
        from_id: parentFileId,
        target_text: importPath,
        reason: "no matching file or module found"
      });
      continue;
    }
    const relType = `Imports_File_${targetEntry.label}`;
    try {
      await store.insertEdge(relType, parentFileId, targetEntry.id, {
        confidence: CONFIDENCE_STATIC_IMPORT,
        resolution_method: "static"
      });
      result.importsResolved++;
    } catch {
    }
  }
}
function resolveImportPath(importPath, fromFileId, index) {
  if (index.byQn.has(importPath))
    return index.byQn.get(importPath) ?? null;
  const fromDir = fromFileId.split("/").slice(0, -1).join("/");
  const candidates = [
    `${fromDir}/${importPath}.ts`,
    `${fromDir}/${importPath}.js`,
    `${fromDir}/${importPath}/index.ts`,
    `${fromDir}/${importPath}/index.js`,
    `${importPath}.ts`,
    `${importPath}.js`
  ];
  for (const c of candidates) {
    if (index.byQn.has(c))
      return index.byQn.get(c) ?? null;
  }
  const lastName = importPath.split("/").pop()?.split(".")[0] ?? "";
  if (lastName && index.byName.has(lastName)) {
    const candidates2 = index.byName.get(lastName) ?? [];
    if (candidates2.length > 0)
      return candidates2[0] ?? null;
  }
  return null;
}
async function resolveCalls(store, index, result) {
  const callSites = await store.nodesOfLabel("CallSite");
  result.totalRefs += callSites.length;
  for (const cs of callSites) {
    const calleeName = String(cs["callee_name"] ?? "");
    const fromId = String(cs["name"] ?? "");
    if (!calleeName || !fromId)
      continue;
    const fromNode = await store.findNodeById(fromId);
    const fromLabel = fromNode ? String(fromNode["label"] ?? "Function") : "Function";
    const _targetLabel = fromLabel === "Method" ? "Method" : "Function";
    const target = index.byName.get(calleeName);
    if (!target || target.length === 0) {
      result.unresolved.push({
        kind: "call",
        from_id: fromId,
        target_text: calleeName,
        reason: "no matching function or method"
      });
      continue;
    }
    const best = target[0];
    if (!best)
      continue;
    const callLabel = best.label === "Method" ? "Method" : "Function";
    const relType = `Calls_${fromLabel}_${callLabel}`;
    const knownCallRels = [
      "Calls_Function_Function",
      "Calls_Function_Method",
      "Calls_Method_Function",
      "Calls_Method_Method"
    ];
    if (!knownCallRels.includes(relType))
      continue;
    try {
      await store.insertEdge(relType, fromId, best.id, {
        confidence: CONFIDENCE_CALL_NAME_MATCH,
        resolution_method: "name-match"
      });
      result.callsResolved++;
    } catch {
    }
  }
}
async function resolveStructuralRefs(store, index, _result) {
  const methodNodes = await store.nodesOfLabel("Method");
  for (const method of methodNodes) {
    const qn = String(method["qualified_name"] ?? "");
    const parts = qn.split("::");
    const MIN_QN_PARTS_FOR_METHOD = 3;
    if (parts.length < MIN_QN_PARTS_FOR_METHOD)
      continue;
    const fileId = parts[0];
    const className = parts[parts.length - 2];
    const structQn = `${fileId}::${className}`;
    const structNode = index.byQn.get(structQn);
    if (!structNode)
      continue;
    const relType = `HasMethod_${structNode.label}_Method`;
    if (!["HasMethod_Struct_Method", "HasMethod_Enum_Method", "HasMethod_Trait_Method"].includes(relType))
      continue;
    try {
      await store.insertEdge(relType, structNode.id, String(method["id"] ?? ""));
    } catch {
    }
  }
}

// packages/mcp-servers/codebase/dist/clustering.js
var MAX_PASSES_LOUVAIN_CONST = 100;
var W_CALLS = 3;
var W_IMPLEMENTS = 2;
var W_IMPORTS = 1;
var W_STRUCT = 5;
function edgeWeight(relName) {
  if (relName.startsWith("Calls_"))
    return W_CALLS;
  if (relName.startsWith("Implements_") || relName.startsWith("Extends_"))
    return W_IMPLEMENTS;
  if (relName.startsWith("Imports_") || relName.startsWith("Uses_"))
    return W_IMPORTS;
  if (relName.startsWith("HasMethod_") || relName.startsWith("HasField_") || relName.startsWith("HasVariant_"))
    return W_STRUCT;
  return 0;
}
var EDGE_REL_TABLES = [
  ["Calls_Function_Function", "Function", "Function"],
  ["Calls_Function_Method", "Function", "Method"],
  ["Calls_Method_Function", "Method", "Function"],
  ["Calls_Method_Method", "Method", "Method"],
  ["Imports_File_Function", "File", "Function"],
  ["Imports_File_Struct", "File", "Struct"],
  ["Imports_File_Enum", "File", "Enum"],
  ["Imports_File_Trait", "File", "Trait"],
  ["Implements_Struct_Trait", "Struct", "Trait"],
  ["Implements_Enum_Trait", "Enum", "Trait"],
  ["Extends_Trait_Trait", "Trait", "Trait"],
  ["Uses_Function_Struct", "Function", "Struct"],
  ["Uses_Function_Enum", "Function", "Enum"],
  ["Uses_Function_Trait", "Function", "Trait"],
  ["Uses_Method_Struct", "Method", "Struct"],
  ["Uses_Method_Enum", "Method", "Enum"],
  ["Uses_Method_Trait", "Method", "Trait"],
  ["HasMethod_Struct_Method", "Struct", "Method"],
  ["HasMethod_Enum_Method", "Enum", "Method"],
  ["HasMethod_Trait_Method", "Trait", "Method"],
  ["HasField_Struct_Field", "Struct", "Field"],
  ["HasField_Enum_Field", "Enum", "Field"],
  ["HasVariant_Enum_Variant", "Enum", "Variant"]
];
var SYMBOL_LABELS = [
  "Function",
  "Method",
  "Struct",
  "Enum",
  "Trait",
  "Constant",
  "TypeAlias",
  "Module"
];
async function extractAdjacency(store) {
  const nodeIds = [];
  const nodeLabels = [];
  const idToIdx = /* @__PURE__ */ new Map();
  for (const label of SYMBOL_LABELS) {
    const nodes = await store.nodesOfLabel(label);
    for (const node of nodes) {
      const id = String(node["id"] ?? "");
      if (!id || idToIdx.has(id))
        continue;
      idToIdx.set(id, nodeIds.length);
      nodeIds.push(id);
      nodeLabels.push(label);
    }
  }
  const n = nodeIds.length;
  const neighbors = Array.from({ length: n }, () => []);
  let totalWeight = 0;
  for (const [relType] of EDGE_REL_TABLES) {
    const w = edgeWeight(relType);
    if (w === 0)
      continue;
    const edges = await store.edgesOfType(relType);
    for (const edge of edges) {
      const a = idToIdx.get(edge.from_id);
      const b = idToIdx.get(edge.to_id);
      if (a === void 0 || b === void 0)
        continue;
      neighbors[a].push([b, w]);
      neighbors[b].push([a, w]);
      totalWeight += w;
    }
  }
  return { nodeIds, nodeLabels, idToIdx, neighbors, totalWeight };
}
function louvain(adj, gamma) {
  const n = adj.nodeIds.length;
  if (n === 0)
    return [[], 0];
  const m = adj.totalWeight;
  if (m === 0)
    return [Array.from({ length: n }, (_, i) => i), 0];
  const twoM = 2 * m;
  const k = adj.neighbors.map((nbrs) => nbrs.reduce((acc, [, w]) => acc + w, 0));
  const comm = Array.from({ length: n }, (_, i) => i);
  const sigmaTot = [...k];
  for (let pass = 0; pass < MAX_PASSES_LOUVAIN_CONST; pass++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      const oldC = comm[i];
      const ki = k[i];
      const kiIn = /* @__PURE__ */ new Map();
      for (const [nbr, w] of adj.neighbors[i]) {
        const c = comm[nbr];
        kiIn.set(c, (kiIn.get(c) ?? 0) + w);
      }
      sigmaTot[oldC] -= ki;
      const kiInOld = kiIn.get(oldC) ?? 0;
      let bestC = oldC;
      let bestGain = kiInOld - gamma * sigmaTot[oldC] * ki / twoM;
      for (const [c, kiInC] of kiIn) {
        const gain = kiInC - gamma * sigmaTot[c] * ki / twoM;
        if (gain > bestGain) {
          bestGain = gain;
          bestC = c;
        }
      }
      comm[i] = bestC;
      sigmaTot[bestC] += ki;
      if (bestC !== oldC)
        improved = true;
    }
    if (!improved)
      break;
  }
  const renumbered = renumberCommunities(comm);
  const q = computeModularity(adj.neighbors, renumbered, k, m);
  return [renumbered, q];
}
function renumberCommunities(comm) {
  const map = /* @__PURE__ */ new Map();
  let next = 0;
  return comm.map((c) => {
    if (!map.has(c))
      map.set(c, next++);
    return map.get(c);
  });
}
function computeModularity(neighbors, comm, k, m) {
  if (m === 0)
    return 0;
  const twoM = 2 * m;
  let q = 0;
  for (let i = 0; i < neighbors.length; i++) {
    for (const [j, w] of neighbors[i]) {
      if (comm[i] === comm[j]) {
        q += w - k[i] * k[j] / twoM;
      }
    }
  }
  return q / twoM;
}
function repairC2(adj, comm) {
  void comm.length;
  const numComms = Math.max(...comm) + 1;
  let nextComm = numComms;
  for (let c = 0; c < numComms; c++) {
    const members = comm.map((v, i) => v === c ? i : -1).filter((i) => i >= 0);
    if (members.length <= 1)
      continue;
    const components = connectedComponentsWithin(members, adj.neighbors, comm, c);
    if (components.length <= 1)
      continue;
    for (let ci = 1; ci < components.length; ci++) {
      for (const node of components[ci]) {
        comm[node] = nextComm;
      }
      nextComm++;
    }
  }
  const renumbered = renumberCommunities(comm);
  comm.splice(0, comm.length, ...renumbered);
}
function connectedComponentsWithin(members, neighbors, comm, community) {
  const memberSet = new Set(members);
  const visited = /* @__PURE__ */ new Set();
  const components = [];
  for (const start of members) {
    if (visited.has(start))
      continue;
    const component = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const node = queue.shift();
      component.push(node);
      for (const [nbr] of neighbors[node]) {
        if (memberSet.has(nbr) && comm[nbr] === community && !visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    components.push(component);
  }
  return components;
}
async function persistCommunities(store, adj, comm, modularity, gamma) {
  const numComms = comm.length > 0 ? Math.max(...comm) + 1 : 0;
  if (numComms === 0)
    return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const c of comm)
    counts.set(c, (counts.get(c) ?? 0) + 1);
  const communityRows = [];
  for (let c = 0; c < numComms; c++) {
    const cid = `community::louvain::${gamma}::${c}`;
    communityRows.push({
      id: cid,
      name: `community_${c}`,
      algorithm: "louvain+c2",
      resolution_param: gamma,
      member_count: counts.get(c) ?? 0,
      modularity_contribution: modularity
    });
  }
  await store.bulkInsertNodes("Community", communityRows);
  const byRel = /* @__PURE__ */ new Map();
  for (let idx = 0; idx < comm.length; idx++) {
    const c = comm[idx];
    const nodeId = adj.nodeIds[idx];
    const label = adj.nodeLabels[idx];
    const cid = `community::louvain::${gamma}::${c}`;
    const rel = `MemberOf_${label}_Community`;
    if (!byRel.has(rel))
      byRel.set(rel, []);
    byRel.get(rel).push({ from: nodeId, to: cid });
  }
  for (const [rel, edges] of byRel) {
    const knownMemberOfRels = [
      "MemberOf_Function_Community",
      "MemberOf_Method_Community",
      "MemberOf_Struct_Community",
      "MemberOf_Enum_Community",
      "MemberOf_Trait_Community",
      "MemberOf_Constant_Community",
      "MemberOf_TypeAlias_Community",
      "MemberOf_Module_Community"
    ];
    if (!knownMemberOfRels.includes(rel))
      continue;
    await store.bulkInsertEdges(rel, edges);
  }
  return numComms;
}
async function detectEntryPoints(store) {
  const entries = [];
  const mainFuncs = await store.nodesOfLabel("Function");
  for (const node of mainFuncs) {
    const name = String(node["name"] ?? "");
    const id = String(node["id"] ?? "");
    const qn = String(node["qualified_name"] ?? id);
    if (name === "main") {
      entries.push({ id, label: "Function", name, qualifiedName: qn, kind: "main", confidence: 1 });
    } else if (name.startsWith("test_") || name.startsWith("test")) {
      entries.push({ id, label: "Function", name, qualifiedName: qn, kind: "test", confidence: 1 });
    } else if (name.startsWith("do_") || name.endsWith("_handler") || name.endsWith("Handler")) {
      entries.push({ id, label: "Function", name, qualifiedName: qn, kind: "handler", confidence: 0.8 });
    }
  }
  for (const node of mainFuncs) {
    const vis = String(node["visibility"] ?? "");
    const id = String(node["id"] ?? "");
    const qn = String(node["qualified_name"] ?? id);
    if ((vis === "pub" || vis === "export") && !entries.find((e) => e.id === id)) {
      const parts = qn.split("::");
      if (parts.length === 2) {
        entries.push({ id, label: "Function", name: String(node["name"] ?? ""), qualifiedName: qn, kind: "lib_entry", confidence: 0.6 });
      }
    }
  }
  return entries;
}
var MAX_BFS_DEPTH = 20;
async function traceProcesses(store) {
  const entries = await detectEntryPoints(store);
  const callEdges = /* @__PURE__ */ new Map();
  const idToLabel = /* @__PURE__ */ new Map();
  for (const label of ["Function", "Method"]) {
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      idToLabel.set(String(n["id"] ?? ""), label);
    }
  }
  for (const [relType] of [
    ["Calls_Function_Function"],
    ["Calls_Function_Method"],
    ["Calls_Method_Function"],
    ["Calls_Method_Method"]
  ]) {
    const edges = await store.edgesOfType(relType);
    for (const e of edges) {
      if (!callEdges.has(e.from_id))
        callEdges.set(e.from_id, []);
      callEdges.get(e.from_id).push(e.to_id);
    }
  }
  const processes = [];
  for (const entry of entries) {
    const processId = `process::${entry.qualifiedName}`;
    const { visited, maxDepth } = bfsFromEntry(entry.id, callEdges);
    await store.insertNode("Process", {
      id: processId,
      name: processId,
      entry_point_id: entry.id,
      entry_kind: entry.kind,
      entry_confidence: entry.confidence,
      depth: maxDepth,
      symbol_count: visited.size
    });
    const epRel = `EntryPointOf_${entry.label}_Process`;
    const knownEpRels = ["EntryPointOf_Function_Process", "EntryPointOf_Method_Process"];
    if (knownEpRels.includes(epRel)) {
      try {
        await store.insertEdge(epRel, entry.id, processId, { confidence: entry.confidence });
      } catch {
      }
    }
    const byRel = /* @__PURE__ */ new Map();
    for (const nodeId of visited) {
      const label = idToLabel.get(nodeId);
      if (!label)
        continue;
      const rel = `ParticipatesIn_${label}_Process`;
      const knownPartRels = ["ParticipatesIn_Function_Process", "ParticipatesIn_Method_Process"];
      if (!knownPartRels.includes(rel))
        continue;
      if (!byRel.has(rel))
        byRel.set(rel, []);
      byRel.get(rel).push({ from: nodeId, to: processId, props: { depth: 0 } });
    }
    for (const [rel, edges] of byRel) {
      await store.bulkInsertEdges(rel, edges.map((e) => ({
        from: e.from,
        to: e.to,
        props: e.props
      })));
    }
    processes.push({
      name: processId,
      entryPoint: entry.qualifiedName,
      entryKind: entry.kind,
      depth: maxDepth,
      nodeCount: visited.size
    });
  }
  return processes;
}
function bfsFromEntry(startId, callEdges) {
  const visited = /* @__PURE__ */ new Set();
  const queue = [[startId, 0]];
  visited.add(startId);
  let maxDepth = 0;
  while (queue.length > 0) {
    const [nodeId, depth] = queue.shift();
    if (depth > maxDepth)
      maxDepth = depth;
    if (depth >= MAX_BFS_DEPTH)
      continue;
    for (const target of callEdges.get(nodeId) ?? []) {
      if (!visited.has(target)) {
        visited.add(target);
        queue.push([target, depth + 1]);
      }
    }
  }
  return { visited, maxDepth };
}
async function clusterGraph(store, gamma = 1) {
  const startMs = Date.now();
  const adj = await extractAdjacency(store);
  const [comm, modularity] = louvain(adj, gamma);
  repairC2(adj, comm);
  const communities = await persistCommunities(store, adj, comm, modularity, gamma);
  const processInfos = await traceProcesses(store);
  await store.updatePhase("clustered");
  return {
    communities,
    modularity,
    processes: processInfos.length,
    elapsedMs: Date.now() - startMs
  };
}
async function getProcesses(store) {
  const nodes = await store.nodesOfLabel("Process");
  return nodes.map((n) => ({
    name: String(n["name"] ?? ""),
    entryPoint: String(n["entry_point_id"] ?? ""),
    entryKind: String(n["entry_kind"] ?? ""),
    depth: Number(n["depth"] ?? 0),
    nodeCount: Number(n["symbol_count"] ?? 0)
  }));
}
async function getImpact(store, qualifiedName) {
  const node = await store.findNode(qualifiedName);
  if (!node)
    return { communities: [], processes: [] };
  const nodeId = String(node["id"] ?? "");
  const label = String(node["label"] ?? "");
  const communities = [];
  const memRel = `MemberOf_${label}_Community`;
  const memEdges = await store.edgesOfType(memRel);
  for (const e of memEdges) {
    if (e.from_id === nodeId)
      communities.push(e.to_id);
  }
  const processes = [];
  for (const partRel of ["ParticipatesIn_Function_Process", "ParticipatesIn_Method_Process"]) {
    const partEdges = await store.edgesOfType(partRel);
    for (const e of partEdges) {
      if (e.from_id === nodeId)
        processes.push(e.to_id);
    }
  }
  return { communities, processes };
}

// packages/mcp-servers/codebase/dist/search.js
var DEFAULT_SEARCH_OPTIONS = {
  limit: 20,
  label_filter: void 0,
  min_score: 0
};
var SEARCHABLE_LABELS = [
  "Function",
  "Method",
  "Struct",
  "Enum",
  "Trait",
  "Module",
  "Constant",
  "TypeAlias"
];
function tokenizeSymbol(s) {
  const tokens = [];
  const parts = s.split(/[:_/\.]+/);
  for (const part of parts) {
    if (!part)
      continue;
    let current = "";
    for (const ch of part) {
      if (ch >= "A" && ch <= "Z" && current.length > 0) {
        tokens.push(current.toLowerCase());
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current)
      tokens.push(current.toLowerCase());
  }
  return tokens.join(" ");
}
var RRF_K = 60;
function rrfFuse(rankingLists, limit) {
  const scores = /* @__PURE__ */ new Map();
  for (const list of rankingLists) {
    for (const entry of list) {
      const contrib = 1 / (RRF_K + entry.rank);
      scores.set(entry.key, (scores.get(entry.key) ?? 0) + contrib);
    }
  }
  return Array.from(scores.entries()).map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}
async function searchGraph(store, query, options = {}) {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0)
    return [];
  const RRF_OVERFETCH = 3;
  const fetchLimit = opts.limit * RRF_OVERFETCH;
  const [pgResults, tfidfResults] = await Promise.all([
    searchPgFts(store, query, fetchLimit, opts.label_filter),
    searchTfIdf(store, terms, fetchLimit, opts.label_filter)
  ]);
  let rankedResults;
  if (pgResults.length > 0 || tfidfResults.length > 0) {
    const pgRanked = pgResults.map((r, i) => ({ key: r.qualified_name, rank: i + 1 }));
    const tfidfRanked = tfidfResults.map((r, i) => ({ key: r.qualified_name, rank: i + 1 }));
    const lists = [pgRanked, tfidfRanked].filter((l) => l.length > 0);
    const RRF_FUSE_MULTIPLIER = 2;
    const fused = rrfFuse(lists, opts.limit * RRF_FUSE_MULTIPLIER);
    const resultMap = /* @__PURE__ */ new Map();
    for (const r of [...pgResults, ...tfidfResults]) {
      if (!resultMap.has(r.qualified_name))
        resultMap.set(r.qualified_name, r);
    }
    rankedResults = [];
    for (const f of fused) {
      const base = resultMap.get(f.key);
      if (base) {
        rankedResults.push({ ...base, score: f.score });
      }
    }
  } else {
    rankedResults = await searchSubstring(store, terms, opts);
  }
  return rankedResults.filter((r) => r.score >= opts.min_score).slice(0, opts.limit);
}
async function searchPgFts(store, query, limit, labelFilter) {
  const tokenized = tokenizeSymbol(query);
  const tsquery = tokenized.split(" ").filter((t) => t.length > 1).join(" & ");
  if (!tsquery)
    return [];
  void (labelFilter ? `AND label = $4` : "");
  const params = [store.graphId, tsquery, limit];
  if (labelFilter)
    params.push(labelFilter);
  const LABELS_PARAM_OFFSET = 4;
  try {
    const r = await store.executeQuery(`SELECT qualified_name, name, label, path,
              start_line, end_line,
              ts_rank(to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(qualified_name, '')),
                      to_tsquery('english', $2)) AS rank
       FROM codebase_nodes
       WHERE graph_id = $1
         AND label = ANY(${labelFilter ? `ARRAY[$${LABELS_PARAM_OFFSET}]` : `ARRAY[${SEARCHABLE_LABELS.map((_, i) => `$${i + LABELS_PARAM_OFFSET}`).join(",")}]`})
         AND to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(qualified_name, ''))
             @@ to_tsquery('english', $2)
       ORDER BY rank DESC
       LIMIT $3`, labelFilter ? params : [store.graphId, tsquery, limit, ...SEARCHABLE_LABELS]);
    return r.rows.map((row) => ({
      qualified_name: String(row[0] ?? ""),
      name: String(row[1] ?? ""),
      label: String(row[2] ?? ""),
      file_path: extractFilePath(String(row[0] ?? "")),
      score: parseFloat(String(row[6] ?? "0")),
      process_names: [],
      start_line: row[4] ? parseInt(String(row[4]), 10) : void 0,
      end_line: row[5] ? parseInt(String(row[5]), 10) : void 0
    }));
  } catch {
    return [];
  }
}
async function searchTfIdf(store, terms, limit, labelFilter) {
  const labels = labelFilter ? [labelFilter] : [...SEARCHABLE_LABELS];
  const candidates = [];
  for (const label of labels) {
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      candidates.push({
        qn: String(n["qualified_name"] ?? n["id"] ?? ""),
        name: String(n["name"] ?? ""),
        label,
        startLine: n["start_line"] ? Number(n["start_line"]) : void 0,
        endLine: n["end_line"] ? Number(n["end_line"]) : void 0
      });
    }
  }
  const scored = candidates.map((c) => ({ c, score: scoreCandidateTfIdf(c.name, c.qn, terms) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map((x) => ({
    qualified_name: x.c.qn,
    name: x.c.name,
    label: x.c.label,
    file_path: extractFilePath(x.c.qn),
    score: x.score,
    process_names: [],
    start_line: x.c.startLine,
    end_line: x.c.endLine
  }));
}
var SCORE_NAME_CONTAINS_BASE = 0.7;
var SCORE_NAME_CONTAINS_RATIO = 0.3;
var SCORE_QN_CONTAINS_BASE = 0.5;
function scoreCandidateTfIdf(name, qn, terms) {
  const nameLower = name.toLowerCase();
  const qnLower = qn.toLowerCase();
  let bestScore = 0;
  for (const term of terms) {
    let ts;
    if (nameLower === term) {
      ts = 1;
    } else if (nameLower && nameLower.includes(term)) {
      const ratio = term.length / nameLower.length;
      ts = SCORE_NAME_CONTAINS_BASE + SCORE_NAME_CONTAINS_RATIO * ratio;
    } else if (qnLower && qnLower.includes(term)) {
      const ratio = term.length / qnLower.length;
      ts = SCORE_QN_CONTAINS_BASE * (1 + ratio);
    } else {
      ts = 0;
    }
    if (ts > bestScore)
      bestScore = ts;
  }
  if (bestScore === 0)
    return 0;
  const MULTI_TERM_BONUS = 0.1;
  const allMatch = terms.every((t) => qnLower.includes(t) || nameLower.includes(t));
  const multiBonus = allMatch && terms.length > 1 ? MULTI_TERM_BONUS : 0;
  return Math.min(bestScore + multiBonus, 1);
}
async function searchSubstring(store, terms, opts) {
  const labels = opts.label_filter ? [opts.label_filter] : [...SEARCHABLE_LABELS];
  const results = [];
  for (const label of labels) {
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      const qn = String(n["qualified_name"] ?? n["id"] ?? "");
      const name = String(n["name"] ?? "");
      const score = scoreCandidateTfIdf(name, qn, terms);
      if (score === 0)
        continue;
      results.push({
        qualified_name: qn,
        name,
        label,
        file_path: extractFilePath(qn),
        score,
        process_names: [],
        start_line: n["start_line"] ? Number(n["start_line"]) : void 0,
        end_line: n["end_line"] ? Number(n["end_line"]) : void 0
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
async function getContext(store, qualifiedName) {
  const resolved = await resolveQualifiedName(store, qualifiedName);
  if (!resolved) {
    const DID_YOU_MEAN_LIMIT = 5;
    const suggestions = await findNameCandidates(store, qualifiedName.split("::").pop() ?? "", DID_YOU_MEAN_LIMIT);
    throw Object.assign(new Error(`symbol not found: ${qualifiedName}`), {
      notFound: true,
      input: qualifiedName,
      didYouMean: suggestions
    });
  }
  const node = await store.findNode(resolved);
  if (!node)
    throw new Error(`symbol not found after resolution: ${resolved}`);
  const label = String(node["label"] ?? "");
  const name = String(node["name"] ?? "");
  const nodeId = String(node["id"] ?? "");
  const [imports, importedBy, calls, calledBy, implements_, implementedBy, uses, usedBy, community, processes] = await Promise.all([
    findRelatedOut(store, nodeId, "Imports_"),
    findRelatedIn(store, nodeId, "Imports_"),
    findRelatedOut(store, nodeId, "Calls_"),
    findRelatedIn(store, nodeId, "Calls_"),
    findRelatedOut(store, nodeId, "Implements_"),
    findRelatedIn(store, nodeId, "Implements_"),
    findRelatedOut(store, nodeId, "Uses_"),
    findRelatedIn(store, nodeId, "Uses_"),
    findCommunity(store, nodeId, label),
    findProcesses(store, nodeId, label)
  ]);
  return {
    qualified_name: resolved,
    name,
    label,
    file_path: extractFilePath(resolved),
    start_line: node["start_line"] ? Number(node["start_line"]) : void 0,
    end_line: node["end_line"] ? Number(node["end_line"]) : void 0,
    visibility: node["visibility"] ? String(node["visibility"]) : void 0,
    imports,
    imported_by: importedBy,
    calls,
    called_by: calledBy,
    implements: implements_,
    implemented_by: implementedBy,
    uses,
    used_by: usedBy,
    community,
    processes
  };
}
async function resolveQualifiedName(store, input) {
  const exact = await store.findNode(input);
  if (exact)
    return String(exact["qualified_name"] ?? exact["id"] ?? input);
  const stripped = stripLeadingPathComponent(input);
  if (stripped) {
    const m2 = await store.findNode(stripped);
    if (m2)
      return String(m2["qualified_name"] ?? m2["id"] ?? stripped);
  }
  return null;
}
function stripLeadingPathComponent(input) {
  const colonIdx = input.indexOf("::");
  const pathPart = colonIdx >= 0 ? input.slice(0, colonIdx) : input;
  const rest = colonIdx >= 0 ? input.slice(colonIdx) : "";
  const slashIdx = pathPart.indexOf("/");
  if (slashIdx < 0)
    return null;
  return pathPart.slice(slashIdx + 1) + rest;
}
async function findNameCandidates(store, name, limit) {
  const labels = ["Function", "Method", "Struct", "Enum", "Trait", "Module"];
  const out = [];
  for (const label of labels) {
    if (out.length >= limit)
      break;
    const nodes = await store.nodesOfLabel(label);
    for (const n of nodes) {
      if (out.length >= limit)
        break;
      if (String(n["name"] ?? "") === name) {
        out.push(String(n["qualified_name"] ?? n["id"] ?? ""));
      }
    }
  }
  return out;
}
async function findRelatedOut(store, nodeId, prefix) {
  const edges = await store.outEdges(nodeId);
  const related = [];
  for (const e of edges) {
    if (!e.rel_type.startsWith(prefix))
      continue;
    const target = await store.findNodeById(e.to_id);
    if (target) {
      related.push({
        name: String(target["name"] ?? ""),
        qualified_name: String(target["qualified_name"] ?? target["id"] ?? ""),
        label: String(target["label"] ?? "")
      });
    }
  }
  return related;
}
async function findRelatedIn(store, nodeId, prefix) {
  const edges = await store.inEdges(nodeId);
  const related = [];
  for (const e of edges) {
    if (!e.rel_type.startsWith(prefix))
      continue;
    const src = await store.findNodeById(e.from_id);
    if (src) {
      related.push({
        name: String(src["name"] ?? ""),
        qualified_name: String(src["qualified_name"] ?? src["id"] ?? ""),
        label: String(src["label"] ?? "")
      });
    }
  }
  return related;
}
async function findCommunity(store, nodeId, label) {
  const rel = `MemberOf_${label}_Community`;
  const edges = await store.outEdges(nodeId);
  const memEdge = edges.find((e) => e.rel_type === rel);
  if (!memEdge)
    return void 0;
  const comm = await store.findNodeById(memEdge.to_id);
  if (!comm)
    return void 0;
  return {
    id: String(comm["id"] ?? ""),
    name: String(comm["name"] ?? ""),
    member_count: Number(comm["member_count"] ?? 0)
  };
}
async function findProcesses(store, nodeId, label) {
  const procs = [];
  if (!["Function", "Method"].includes(label))
    return procs;
  const edges = await store.outEdges(nodeId);
  for (const e of edges) {
    if (e.rel_type.startsWith("EntryPointOf_")) {
      const p = await store.findNodeById(e.to_id);
      if (p)
        procs.push({ name: String(p["name"] ?? ""), role: "entry_point" });
    } else if (e.rel_type.startsWith("ParticipatesIn_")) {
      const p = await store.findNodeById(e.to_id);
      if (p) {
        const pname = String(p["name"] ?? "");
        if (!procs.find((pr) => pr.name === pname)) {
          procs.push({ name: pname, role: "participant" });
        }
      }
    }
  }
  return procs;
}
async function getSymbol(store, qualifiedName) {
  const resolved = await resolveQualifiedName(store, qualifiedName);
  if (!resolved)
    return null;
  const node = await store.findNode(resolved);
  if (!node)
    return null;
  const nodeId = String(node["id"] ?? "");
  const [outEs, inEs] = await Promise.all([
    store.outEdges(nodeId),
    store.inEdges(nodeId)
  ]);
  return { node, inEdges: inEs, outEdges: outEs };
}
function extractFilePath(qualifiedName) {
  const idx = qualifiedName.indexOf("::");
  return idx >= 0 ? qualifiedName.slice(0, idx) : qualifiedName;
}

// packages/mcp-servers/codebase/dist/git-diff.js
import { execFileSync } from "node:child_process";
var DIFF_LINE_MAX = Number.MAX_SAFE_INTEGER / 2;
function parseUnifiedDiff(diffText) {
  const hunks = [];
  let current = null;
  let currentLine = 0;
  let lineCount = 0;
  for (const line of diffText.split("\n")) {
    if (lineCount++ > DIFF_LINE_MAX)
      break;
    if (line.startsWith("diff --git ")) {
      current = { filePath: "", changedLines: [], isNew: false, isDeleted: false };
      hunks.push(current);
    } else if (line.startsWith("+++ b/") && current) {
      const UNIFIED_DIFF_B_PREFIX_LEN = 6;
      current.filePath = line.slice(UNIFIED_DIFF_B_PREFIX_LEN).trim();
    } else if (line.startsWith("+++ /dev/null") && current) {
      current.isDeleted = true;
    } else if (line.startsWith("--- /dev/null") && current) {
      current.isNew = true;
    } else if (line.startsWith("@@ ") && current) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m)
        currentLine = parseInt(m[1] ?? "1", 10);
    } else if (current && currentLine > 0) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.changedLines.push(currentLine);
        currentLine++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
      } else if (!line.startsWith("\\")) {
        currentLine++;
      }
    }
  }
  return hunks.filter((h) => h.filePath);
}
async function mapLinesToSymbols(store, hunks) {
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const hunk of hunks) {
    if (hunk.changedLines.length === 0)
      continue;
    const candidates = [hunk.filePath];
    const slashIdx = hunk.filePath.indexOf("/");
    if (slashIdx >= 0)
      candidates.push(hunk.filePath.slice(slashIdx + 1));
    for (const filePath of candidates) {
      try {
        const qr = await store.executeQuery(`SELECT id, name, label, qualified_name, start_line, end_line
           FROM codebase_nodes
           WHERE graph_id = $1
             AND path = $2
             AND start_line IS NOT NULL
             AND end_line IS NOT NULL
             AND label = ANY(ARRAY['Function','Method','Struct','Enum','Trait'])`, [store.graphId, filePath]);
        for (const row of qr.rows) {
          const id = String(row[0] ?? "");
          const name = String(row[1] ?? "");
          const label = String(row[2] ?? "");
          const qn = String(row[3] ?? id);
          const sl = parseInt(String(row[4] ?? "0"), 10);
          const el = parseInt(String(row[5] ?? "0"), 10);
          const overlaps = hunk.changedLines.some((l) => l >= sl && l <= el);
          if (!overlaps)
            continue;
          if (seen.has(qn))
            continue;
          seen.add(qn);
          const changeType = hunk.isNew ? "added" : hunk.isDeleted ? "deleted" : "modified";
          let communityId;
          const outEdges = await store.outEdges(id);
          const memEdge = outEdges.find((e) => e.rel_type.startsWith("MemberOf_"));
          if (memEdge)
            communityId = memEdge.to_id;
          const processNames = [];
          for (const e of outEdges) {
            if (e.rel_type.startsWith("ParticipatesIn_")) {
              const p = await store.findNodeById(e.to_id);
              if (p)
                processNames.push(String(p["name"] ?? ""));
            }
          }
          result.push({
            qualified_name: qn,
            name,
            label,
            file_path: filePath,
            change_type: changeType,
            lines_changed: hunk.changedLines.filter((l) => l >= sl && l <= el).length,
            community_id: communityId,
            processes: processNames
          });
        }
      } catch {
        continue;
      }
    }
  }
  return result;
}
var RISK_BASE_PER_SYMBOL = 0.1;
var RISK_ADD_DELETE_BONUS = 0.1;
var RISK_HIGH_FANOUT_BONUS = 0.2;
var RISK_PER_COMMUNITY = 0.05;
var RISK_PER_PROCESS = 0.05;
var HIGH_FANOUT_THRESHOLD = 2;
function computeRiskScore(symbols) {
  if (symbols.length === 0)
    return 0;
  let score = 0;
  const commSet = /* @__PURE__ */ new Set();
  const procSet = /* @__PURE__ */ new Set();
  for (const s of symbols) {
    score += RISK_BASE_PER_SYMBOL;
    if (s.change_type === "added" || s.change_type === "deleted")
      score += RISK_ADD_DELETE_BONUS;
    if (s.community_id)
      commSet.add(s.community_id);
    for (const p of s.processes)
      procSet.add(p);
    if (s.processes.length > HIGH_FANOUT_THRESHOLD)
      score += RISK_HIGH_FANOUT_BONUS;
  }
  score += commSet.size * RISK_PER_COMMUNITY;
  score += procSet.size * RISK_PER_PROCESS;
  return Math.min(score, 1);
}
async function analyzeDiff(store, diffText) {
  const hunks = parseUnifiedDiff(diffText);
  const symbols = await mapLinesToSymbols(store, hunks);
  const communities = [...new Set(symbols.map((s) => s.community_id).filter(Boolean))];
  const processes = [...new Set(symbols.flatMap((s) => s.processes))];
  return {
    files_changed: hunks.length,
    symbols_affected: symbols,
    communities_affected: communities,
    processes_affected: processes,
    risk_score: computeRiskScore(symbols)
  };
}
async function analyzeGitDiff(store, codebasePath, baseRef, headRef) {
  for (const [ref, field] of [[baseRef, "base_ref"], [headRef, "head_ref"]]) {
    if (!ref)
      throw new Error(`invalid_ref: ${field} must not be empty`);
    if (ref.startsWith("-"))
      throw new Error(`invalid_ref: ${field} must not start with '-'`);
    if (ref.includes("\n") || ref.includes("\0"))
      throw new Error(`invalid_ref: ${field} must not contain newline or NUL`);
  }
  let diffText;
  try {
    diffText = execFileSync("git", ["diff", baseRef, headRef], {
      cwd: codebasePath,
      encoding: "utf8",
      timeout: 3e4
      // source: tool_schemas.rs lsp_resolve_schema timeout_ms default
    });
  } catch (e) {
    throw new Error(`git diff failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return analyzeDiff(store, diffText);
}

// packages/mcp-servers/codebase/dist/security-gates.js
import * as fs3 from "node:fs";
import * as path3 from "node:path";
var AUTH_CRITICAL_PATTERNS = [
  "auth",
  "password",
  "token",
  "permission",
  "role",
  "crypto",
  "encrypt",
  "decrypt",
  "verify",
  "jwt",
  "oauth",
  "session"
];
async function checkSecurityGates(store, changedSymbols) {
  const flags = [];
  const authCommunities = await findAuthCommunities(store);
  for (const sym of changedSymbols) {
    let ctx;
    try {
      ctx = await getContext(store, sym);
    } catch {
      continue;
    }
    if (ctx.community) {
      const commName = (ctx.community.name + ctx.community.id).toLowerCase();
      if (authCommunities.has(ctx.community.id) || AUTH_CRITICAL_PATTERNS.some((p) => commName.includes(p))) {
        flags.push({
          gate: "S1",
          severity: "critical",
          symbol: sym,
          message: "Changed symbol shares a community with auth-critical code",
          details: { community_id: ctx.community.id }
        });
      }
    }
    flags.push({
      gate: "S2",
      severity: "info",
      symbol: sym,
      message: "Unsafe symbol check skipped: parser does not record is_unsafe",
      details: {}
    });
    if (ctx.visibility === "pub" || ctx.visibility === "export") {
      const parts = ctx.qualified_name.split("::");
      if (parts.length === 2) {
        flags.push({
          gate: "S3",
          severity: "warning",
          symbol: sym,
          message: "Public-API symbol changed",
          details: { qualified_name: ctx.qualified_name }
        });
      }
    }
    const unresolvedImports = ctx.imports.filter((i) => i.label === "Import");
    if (unresolvedImports.length > 0) {
      flags.push({
        gate: "S4",
        severity: "warning",
        symbol: sym,
        message: `Symbol has ${unresolvedImports.length} unresolved import(s)`,
        details: { unresolved: unresolvedImports.map((i) => i.qualified_name) }
      });
    }
    const testProcesses = ctx.processes.filter((p) => p.name.includes("::test") || p.name.startsWith("test"));
    if (testProcesses.length === 0) {
      flags.push({
        gate: "S5",
        severity: "warning",
        symbol: sym,
        message: "Changed symbol has no reachable test process",
        details: { processes: ctx.processes.map((p) => p.name) }
      });
    }
  }
  const criticalCount = flags.filter((f) => f.severity === "critical").length;
  const warningCount = flags.filter((f) => f.severity === "warning").length;
  const infoCount = flags.filter((f) => f.severity === "info").length;
  return {
    gates_passed: criticalCount === 0,
    flags,
    summary: {
      changed_symbols: changedSymbols.length,
      critical_count: criticalCount,
      warning_count: warningCount,
      info_count: infoCount
    }
  };
}
async function findAuthCommunities(store) {
  const communities = await store.nodesOfLabel("Community");
  const authCommunityIds = /* @__PURE__ */ new Set();
  for (const c of communities) {
    const name = (String(c["name"] ?? "") + String(c["id"] ?? "")).toLowerCase();
    if (AUTH_CRITICAL_PATTERNS.some((p) => name.includes(p))) {
      authCommunityIds.add(String(c["id"] ?? ""));
    }
  }
  return authCommunityIds;
}
function writeSecurityReport(outputDir, runId, findingId, report) {
  const dir = path3.join(outputDir, "runs", runId, "findings", findingId);
  fs3.mkdirSync(dir, { recursive: true });
  const p = path3.join(dir, "stage-8.security.json");
  fs3.writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}

// packages/mcp-servers/codebase/dist/semantic-diff.js
import * as fs4 from "node:fs";
var WEIGHT_DANGLING = 1;
var WEIGHT_NEW_CYCLE = 0.5;
var WEIGHT_UNRESOLVED_DELTA = 0.1;
var UNRESOLVED_DELTA_MAX = 5;
var REGRESSION_SCORE_CAP = 10;
var VERDICT_CLEAN_MAX = 1;
var VERDICT_CONCERNING_MAX = 5;
var DETAILS_TRUNCATION = 100;
var DIFFABLE_LABELS = [
  "Function",
  "Method",
  "Struct",
  "Enum",
  "Trait",
  "Module",
  "Constant",
  "TypeAlias"
];
async function diffGraphs(beforeGraphPath, afterGraphPath, reportPath) {
  const verifiedAt = (/* @__PURE__ */ new Date()).toISOString();
  let beforeStore;
  let afterStore;
  try {
    beforeStore = await GraphStore.fromGraphPath(beforeGraphPath);
    afterStore = await GraphStore.fromGraphPath(afterGraphPath);
  } catch (e) {
    throw new Error(`failed to open graphs: ${e instanceof Error ? e.message : String(e)}`);
  }
  const beforeNodes = /* @__PURE__ */ new Set();
  const afterNodes = /* @__PURE__ */ new Set();
  for (const label of DIFFABLE_LABELS) {
    const beforeLabelNodes = await beforeStore.nodesOfLabel(label);
    for (const n of beforeLabelNodes) {
      const qn = String(n["qualified_name"] ?? n["id"] ?? "");
      if (qn)
        beforeNodes.add(`${label}::${qn}`);
    }
    const afterLabelNodes = await afterStore.nodesOfLabel(label);
    for (const n of afterLabelNodes) {
      const qn = String(n["qualified_name"] ?? n["id"] ?? "");
      if (qn)
        afterNodes.add(`${label}::${qn}`);
    }
  }
  const nodesAdded = [...afterNodes].filter((n) => !beforeNodes.has(n));
  const nodesRemoved = [...beforeNodes].filter((n) => !afterNodes.has(n));
  const beforeEdges = await collectEdgeSet(beforeStore);
  const afterEdges = await collectEdgeSet(afterStore);
  const edgesAdded = [...afterEdges].filter((e) => !beforeEdges.has(e));
  const edgesRemoved = [...beforeEdges].filter((e) => !afterEdges.has(e));
  const afterNodeIds = new Set([...afterNodes].map((n) => n.split("::").slice(1).join("::")));
  const dangling = edgesAdded.filter((e) => {
    const parts = e.split("|");
    const toId = parts[2] ?? "";
    return nodesRemoved.some((r) => r.split("::").slice(1).join("::") === toId) || !afterNodeIds.has(toId);
  });
  const beforeUnresolved = await countUnresolvedImports(beforeStore);
  const afterUnresolved = await countUnresolvedImports(afterStore);
  const newUnresolvedDelta = afterUnresolved - beforeUnresolved;
  const newCycles = await detectNewCycles(afterStore, beforeStore);
  const summary = {
    nodes_added: nodesAdded.length,
    nodes_removed: nodesRemoved.length,
    edges_added: edgesAdded.length,
    edges_removed: edgesRemoved.length,
    dangling_references: dangling.length,
    new_unresolved_delta: newUnresolvedDelta,
    new_cycles: newCycles
  };
  let score = 0;
  score += dangling.length * WEIGHT_DANGLING;
  score += newCycles * WEIGHT_NEW_CYCLE;
  score += Math.min(Math.max(newUnresolvedDelta, 0), UNRESOLVED_DELTA_MAX) * WEIGHT_UNRESOLVED_DELTA;
  score = Math.min(score, REGRESSION_SCORE_CAP);
  const verdict = score < VERDICT_CLEAN_MAX ? "clean" : score < VERDICT_CONCERNING_MAX ? "concerning" : "regression";
  const report = {
    verified_at: verifiedAt,
    before_graph_path: beforeGraphPath,
    after_graph_path: afterGraphPath,
    summary,
    regression_score: score,
    verdict,
    details: {
      nodes_added: nodesAdded.slice(0, DETAILS_TRUNCATION),
      nodes_removed: nodesRemoved.slice(0, DETAILS_TRUNCATION),
      dangling_references: dangling.slice(0, DETAILS_TRUNCATION)
    }
  };
  if (reportPath) {
    fs4.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
  return { summary, regression_score: score, verdict, report };
}
async function collectEdgeSet(store) {
  const edges = /* @__PURE__ */ new Set();
  const relTypes = [
    "Calls_Function_Function",
    "Calls_Function_Method",
    "Calls_Method_Function",
    "Calls_Method_Method",
    "Implements_Struct_Trait",
    "Extends_Trait_Trait"
  ];
  for (const rel of relTypes) {
    const es = await store.edgesOfType(rel);
    for (const e of es)
      edges.add(`${e.from_id}|${rel}|${e.to_id}`);
  }
  return edges;
}
async function countUnresolvedImports(store) {
  const importNodes = await store.nodesOfLabel("Import");
  return importNodes.length;
}
async function detectNewCycles(afterStore, _beforeStore) {
  const edges = await afterStore.edgesOfType("Calls_Function_Function");
  const adj = /* @__PURE__ */ new Map();
  for (const e of edges) {
    if (!adj.has(e.from_id))
      adj.set(e.from_id, []);
    (adj.get(e.from_id) ?? []).push(e.to_id);
  }
  let cycleCount = 0;
  for (const [from, tos] of adj) {
    for (const to of tos) {
      if (to === from) {
        cycleCount++;
        continue;
      }
      const toNeighbors = adj.get(to) ?? [];
      if (toNeighbors.includes(from))
        cycleCount++;
    }
  }
  return Math.floor(cycleCount / 2);
}

// packages/mcp-servers/codebase/dist/prd-input.js
import * as fs5 from "node:fs";
import * as path4 from "node:path";
var MATCHES_PER_TOKEN = 3;
var PREPARER_VERSION = "1.0.0";
var PRD_INPUT_FILE_NAME = "stage-4.prd_input.json";
var MIN_TOKEN_LEN = 3;
var MAX_TOKENS = 32;
async function preparePrdInput(store, runId, findingId, outputDir) {
  const findingDir = path4.join(outputDir, "runs", runId, "findings", findingId);
  const verifiedPath2 = path4.join(findingDir, "stage-2.verified.json");
  if (!fs5.existsSync(verifiedPath2))
    throw new Error("stage-2.verified.json not found: complete verification first");
  const verified = JSON.parse(fs5.readFileSync(verifiedPath2, "utf8"));
  const refinedPath = path4.join(findingDir, "stage-1.refined.json");
  if (!fs5.existsSync(refinedPath))
    throw new Error("stage-1.refined.json not found");
  const refined = JSON.parse(fs5.readFileSync(refinedPath, "utf8"));
  const extracted = refined["extracted"] ?? {};
  const title = String(extracted["title"] ?? "");
  const description = String(extracted["description"] ?? "");
  const combinedText = `${title} ${description}`;
  const tokens = combinedText.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9_:]/g, "")).filter((t) => t.length >= MIN_TOKEN_LEN).slice(0, MAX_TOKENS);
  const matchedQns = /* @__PURE__ */ new Set();
  for (const token of tokens) {
    const results = await searchGraph(store, token, { limit: MATCHES_PER_TOKEN });
    for (const r of results)
      matchedQns.add(r.qualified_name);
  }
  const communities = /* @__PURE__ */ new Set();
  const processes = /* @__PURE__ */ new Set();
  const symbolContexts = [];
  for (const qn of matchedQns) {
    try {
      const ctx = await getContext(store, qn);
      if (ctx.community)
        communities.add(ctx.community.id);
      for (const p of ctx.processes)
        processes.add(p.name);
      symbolContexts.push({
        qualified_name: ctx.qualified_name,
        name: ctx.name,
        label: ctx.label,
        community: ctx.community?.id,
        processes: ctx.processes.map((p) => p.name),
        calls: ctx.calls.map((c) => c.qualified_name),
        called_by: ctx.called_by.map((c) => c.qualified_name),
        uses: ctx.uses.map((u) => u.qualified_name)
      });
    } catch {
    }
  }
  const artifact = {
    preparer_version: PREPARER_VERSION,
    prepared_at: (/* @__PURE__ */ new Date()).toISOString(),
    run_id: runId,
    finding_id: findingId,
    finding_summary: {
      title,
      description,
      relevance_category: String(extracted["relevance_category"] ?? "")
    },
    verified_digest: String(verified["transcript_digest"] ?? ""),
    matched_symbols: symbolContexts,
    impacted_communities: [...communities],
    impacted_processes: [...processes],
    graph_stats: {
      node_count: await store.nodeCount(),
      edge_count: await store.edgeCount()
    }
  };
  const artifactPath = path4.join(findingDir, PRD_INPUT_FILE_NAME);
  fs5.mkdirSync(findingDir, { recursive: true });
  fs5.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  return {
    artifact_path: artifactPath,
    matched_symbol_count: matchedQns.size,
    impacted_community_count: communities.size,
    impacted_process_count: processes.size
  };
}
async function validatePrdAgainstGraph(store, prdPath, affectedSymbolsPath) {
  const prdText = fs5.readFileSync(prdPath, "utf8");
  let claimedSymbols = [];
  if (affectedSymbolsPath && fs5.existsSync(affectedSymbolsPath)) {
    const aff = JSON.parse(fs5.readFileSync(affectedSymbolsPath, "utf8"));
    if (Array.isArray(aff)) {
      claimedSymbols = aff.map((s) => typeof s === "string" ? s : String(s["qualified_name"] ?? "")).filter(Boolean);
    }
  } else {
    const matches = prdText.matchAll(/`([a-zA-Z0-9/_-]+(?:::[a-zA-Z0-9_]+)+)`/g);
    for (const m of matches) {
      if (m[1])
        claimedSymbols.push(m[1]);
    }
  }
  const hallucinated = [];
  for (const sym of claimedSymbols) {
    const node = await store.findNode(sym);
    if (!node)
      hallucinated.push(sym);
  }
  const communityWarnings = [];
  const communityIds = /* @__PURE__ */ new Set();
  for (const sym of claimedSymbols) {
    const node = await store.findNode(sym);
    if (!node)
      continue;
    const nodeId = String(node["id"] ?? "");
    const edges = await store.outEdges(nodeId);
    const memEdge = edges.find((e) => e.rel_type.startsWith("MemberOf_"));
    if (memEdge)
      communityIds.add(memEdge.to_id);
  }
  const COMMUNITY_CONSISTENCY_THRESHOLD = 3;
  if (communityIds.size > COMMUNITY_CONSISTENCY_THRESHOLD) {
    communityWarnings.push(`Claimed symbols span ${communityIds.size} communities \u2014 may indicate broad scope`);
  }
  const contradictions = [];
  const noImpactClaims = prdText.matchAll(/does not affect\s+["`]?([^"`,\n]+)["`]?/gi);
  for (const claim of noImpactClaims) {
    const processName = claim[1]?.trim() ?? "";
    if (!processName)
      continue;
    for (const sym of claimedSymbols) {
      const node = await store.findNode(sym);
      if (!node)
        continue;
      const nodeId = String(node["id"] ?? "");
      const edges = await store.outEdges(nodeId);
      for (const e of edges) {
        if (e.rel_type.startsWith("ParticipatesIn_")) {
          const p = await store.findNodeById(e.to_id);
          if (p && String(p["name"] ?? "").includes(processName)) {
            contradictions.push(`PRD claims no impact on "${processName}" but ${sym} participates in it`);
          }
        }
      }
    }
  }
  return {
    valid: hallucinated.length === 0 && contradictions.length === 0,
    hallucinated_symbols: hallucinated,
    community_consistency_warnings: communityWarnings,
    process_impact_contradictions: contradictions,
    symbol_count: claimedSymbols.length,
    checked_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// packages/mcp-servers/codebase/dist/findings.js
import * as fs6 from "node:fs";
import * as path5 from "node:path";
import * as crypto from "node:crypto";
var EXTRACTOR_VERSION = "1.0.0";
var VERIFIER_VERSION = "1.0.0";
var SAFE_ID_MAX_LEN = 128;
var RUN_ID_SUFFIX_LEN = 6;
var RUN_ID_ALPHABET_SIZE = 36;
var ATOMIC_SUFFIX_LEN = 4;
var COMPACT_UTC_LEN = 15;
var RUNS_DIR_NAME = "runs";
var FINDINGS_DIR_NAME = "findings";
var INDEX_FILE_NAME = "index.json";
var EXTRACTED_FILE_NAME = "stage-1.extracted.json";
var SOURCE_FILE_NAME = "stage-1.source.json";
var REFINED_FILE_NAME = "stage-1.refined.json";
var SESSION_FILE_NAME = "stage-2.session.json";
var VERIFIED_FILE_NAME = "stage-2.verified.json";
var DIGEST_ALGORITHM = "sha256";
function nowIso8601Utc() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function formatCompactUtc() {
  const now = /* @__PURE__ */ new Date();
  return now.toISOString().replace(/[-:T.Z]/g, "").slice(0, COMPACT_UTC_LEN).replace(/(\d{8})(\d{6})/, "$1-$2");
}
function randomSuffix(len) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes).map((b) => alphabet[(b ?? 0) % RUN_ID_ALPHABET_SIZE] ?? "a").join("");
}
function generateRunId() {
  return `${formatCompactUtc()}-${randomSuffix(RUN_ID_SUFFIX_LEN)}`;
}
function validateSafeId(kind, id) {
  if (!id)
    throw new Error(`unsafe ${kind}: must be non-empty`);
  if (id.length > SAFE_ID_MAX_LEN)
    throw new Error(`unsafe ${kind}: length ${id.length} exceeds max ${SAFE_ID_MAX_LEN}`);
  if (id.startsWith("."))
    throw new Error(`unsafe ${kind}: must not start with '.'`);
  if (id.includes(".."))
    throw new Error(`unsafe ${kind}: must not contain '..'`);
  if (!/^[A-Za-z0-9._-]+$/.test(id))
    throw new Error(`unsafe ${kind}: must match [A-Za-z0-9._-]+`);
}
function requireAbsolute(p, field) {
  if (!path5.isAbsolute(p))
    throw new Error(`${field} must be an absolute path: got ${JSON.stringify(p)}`);
  if (p.includes(".."))
    throw new Error(`${field} must not contain '..': got ${JSON.stringify(p)}`);
  return p;
}
function atomicWrite(target, content) {
  const parent = path5.dirname(target);
  fs6.mkdirSync(parent, { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${randomSuffix(ATOMIC_SUFFIX_LEN)}`;
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  fs6.writeFileSync(tmp, buf);
  fs6.renameSync(tmp, target);
}
function writeJsonAtomic(target, value) {
  atomicWrite(target, JSON.stringify(value, null, 2));
}
function readIndex(indexPath) {
  if (!fs6.existsSync(indexPath))
    return null;
  return JSON.parse(fs6.readFileSync(indexPath, "utf8"));
}
function upsertIndexEntry(outputDir, runId, findingId, entry, mode) {
  const indexPath = path5.join(outputDir, RUNS_DIR_NAME, runId, INDEX_FILE_NAME);
  const now = nowIso8601Utc();
  let idx = readIndex(indexPath);
  if (!idx) {
    idx = { run_id: runId, started_at: now, last_updated_at: now, findings: {} };
  }
  idx.last_updated_at = now;
  const existing = idx.findings[findingId];
  idx.findings[findingId] = mergeEntry(existing, entry, mode);
  writeJsonAtomic(indexPath, idx);
}
function mergeEntry(existing, entry, mode) {
  if (mode === "replace" || !existing)
    return entry;
  if (mode === "preserve_downstream") {
    return {
      ...entry,
      orchestrator_version: existing.orchestrator_version,
      refined_at: existing.refined_at,
      verified_at: existing.verified_at,
      verified: existing.verified,
      stage2_path: existing.stage2_path,
      artifact_path: existing.refined_at ? existing.artifact_path : entry.artifact_path
    };
  }
  if (mode === "preserve_stage2") {
    return {
      ...entry,
      verified_at: existing.verified_at,
      verified: existing.verified,
      stage2_path: existing.stage2_path
    };
  }
  if (mode === "preserve_refined_only") {
    return {
      ...entry,
      artifact_path: existing.artifact_path,
      extractor_version: existing.extractor_version,
      orchestrator_version: existing.orchestrator_version,
      refined_at: existing.refined_at
    };
  }
  return entry;
}
function resolveFinding(findingArg) {
  if (typeof findingArg === "object" && findingArg !== null && !Array.isArray(findingArg)) {
    const finding = findingArg;
    validateRequiredFindingFields(finding);
    return { finding, sourceForm: "inline", sourceBytes: JSON.stringify(finding, null, 2) };
  }
  if (typeof findingArg === "string") {
    requireAbsolute(findingArg, "finding");
    if (findingArg.toLowerCase().endsWith(".md"))
      throw new Error(".md finding inputs are not supported in v1 (spec \xA79.3 Q1); convert to JSON first");
    if (!findingArg.toLowerCase().endsWith(".json"))
      throw new Error(`finding path must end in .json: got ${JSON.stringify(findingArg)}`);
    const raw = fs6.readFileSync(findingArg, "utf8");
    const parsed = JSON.parse(raw);
    let findingValue = parsed;
    if (typeof parsed === "object" && parsed !== null && "findings" in parsed) {
      const arr = parsed.findings;
      if (!Array.isArray(arr) || arr.length !== 1)
        throw new Error(`finding file has findings[${Array.isArray(arr) ? arr.length : "?"}]: stage 1 processes one finding per call`);
      findingValue = arr[0];
    }
    const finding = findingValue;
    validateRequiredFindingFields(finding);
    return { finding, sourceForm: "json_file", sourcePath: findingArg, sourceBytes: JSON.stringify(finding, null, 2) };
  }
  throw new Error("finding must be an object or an absolute path string");
}
function validateRequiredFindingFields(f) {
  if (!f.id || !String(f.id).trim())
    throw new Error("finding.id is required and must be non-empty");
  if (!f.title || !String(f.title).trim())
    throw new Error("finding.title is required and must be non-empty");
  if (!f.relevance_category || !String(f.relevance_category).trim())
    throw new Error("finding.relevance_category is required and must be non-empty");
}
function runExtractFinding(args) {
  try {
    const findingArg = args["finding"];
    const outputDirStr = String(args["output_dir"] ?? "");
    requireAbsolute(outputDirStr, "output_dir");
    const outputDir = outputDirStr;
    const runId = (() => {
      if (!args["run_id"] || args["run_id"] === null)
        return generateRunId();
      const r = String(args["run_id"]);
      validateSafeId("run_id", r);
      return r;
    })();
    const { finding, sourceForm, sourcePath, sourceBytes } = resolveFinding(findingArg);
    const findingId = finding.id;
    validateSafeId("finding_id", findingId);
    const findingDir = path5.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId);
    fs6.mkdirSync(findingDir, { recursive: true });
    const sourcePath2 = path5.join(findingDir, SOURCE_FILE_NAME);
    atomicWrite(sourcePath2, sourceBytes);
    const extracted = {
      finding_id: findingId,
      title: finding.title,
      description: finding.description ?? null,
      source_url: finding.source_url ?? null,
      relevance_category: finding.relevance_category,
      relevance_score: finding.relevance_score ?? null,
      raw_data: finding.raw_data,
      extracted_at: nowIso8601Utc(),
      // source: main.rs format_iso8601_utc() — ISO-8601 timestamp
      extractor_version: EXTRACTOR_VERSION,
      source_form: sourceForm,
      source_path: sourcePath ?? null
    };
    for (const [k, v] of Object.entries(finding)) {
      if (!(k in extracted))
        extracted[k] = v;
    }
    const extractedPath = path5.join(findingDir, EXTRACTED_FILE_NAME);
    writeJsonAtomic(extractedPath, extracted);
    upsertIndexEntry(outputDir, runId, findingId, {
      artifact_path: extractedPath,
      extractor_version: EXTRACTOR_VERSION
    }, "preserve_downstream");
    return {
      stage: 1,
      step: "extract",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      artifact_path: extractedPath,
      source_path: sourcePath ?? null
    };
  } catch (e) {
    return { stage: 1, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}
function runRefineFinding(args) {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    validateSafeId("run_id", runId);
    validateSafeId("finding_id", findingId);
    const refinedPrompt = args["refined_prompt"];
    const refinement = args["refinement"];
    const findingDir = path5.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId);
    const extractedPath = path5.join(findingDir, EXTRACTED_FILE_NAME);
    if (!fs6.existsSync(extractedPath))
      throw new Error(`extract_finding must be called first: ${extractedPath} not found`);
    const extracted = JSON.parse(fs6.readFileSync(extractedPath, "utf8"));
    const now = nowIso8601Utc();
    const artifact = {
      extracted,
      refined_prompt: refinedPrompt,
      refinement: { ...refinement, refined_at: now }
    };
    const refinedPath = path5.join(findingDir, REFINED_FILE_NAME);
    writeJsonAtomic(refinedPath, artifact);
    upsertIndexEntry(outputDir, runId, findingId, {
      artifact_path: refinedPath,
      extractor_version: EXTRACTOR_VERSION,
      orchestrator_version: refinement.orchestrator_version,
      refined_at: now
    }, "preserve_stage2");
    return {
      stage: 1,
      step: "refine",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      artifact_path: refinedPath
    };
  } catch (e) {
    return { stage: 1, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}
function sessionPath(outputDir, runId, findingId) {
  return path5.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, SESSION_FILE_NAME);
}
function verifiedPath(outputDir, runId, findingId) {
  return path5.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, VERIFIED_FILE_NAME);
}
function runStartVerification(args) {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    validateSafeId("run_id", runId);
    validateSafeId("finding_id", findingId);
    const refinedPath = path5.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, REFINED_FILE_NAME);
    if (!fs6.existsSync(refinedPath))
      throw new Error(`stage-1.refined.json not found: refine_finding must be called first`);
    const sp = sessionPath(outputDir, runId, findingId);
    if (fs6.existsSync(sp)) {
      const existing = JSON.parse(fs6.readFileSync(sp, "utf8"));
      if (existing.state === "finalized")
        throw new Error("session already finalized; cannot restart");
    }
    const now = nowIso8601Utc();
    const session = {
      run_id: runId,
      finding_id: findingId,
      state: "open",
      created_at: now,
      updated_at: now,
      turns: []
    };
    writeJsonAtomic(sp, session);
    return { stage: 2, step: "start_verification", status: "ok", run_id: runId, finding_id: findingId, state: "open" };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}
function runAppendClarification(args) {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    const kind = String(args["kind"] ?? "");
    const content = String(args["content"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    const sp = sessionPath(outputDir, runId, findingId);
    if (!fs6.existsSync(sp))
      throw new Error("session not found: call start_verification first");
    const session = JSON.parse(fs6.readFileSync(sp, "utf8"));
    if (session.state === "finalized" || session.state === "aborted")
      throw new Error(`cannot append to session in state '${session.state}'`);
    const lastTurn = session.turns[session.turns.length - 1];
    if (lastTurn && lastTurn.kind === kind)
      throw new Error(`alternation violation: two consecutive '${kind}' turns`);
    const now = nowIso8601Utc();
    session.turns.push({ kind, content, at: now, meta: args["meta"] });
    session.state = kind === "agent_question" ? "waiting_for_user" : "open";
    session.updated_at = now;
    writeJsonAtomic(sp, session);
    return {
      stage: 2,
      step: "append_clarification",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      state: session.state,
      turn_count: session.turns.length
    };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}
function runFinalizeVerification(args) {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    const sp = sessionPath(outputDir, runId, findingId);
    if (!fs6.existsSync(sp))
      throw new Error("session not found");
    const session = JSON.parse(fs6.readFileSync(sp, "utf8"));
    if (session.state === "open" && session.turns.length === 0)
      throw new Error("no_clarification_round: at least one turn required before finalizing");
    if (session.state === "waiting_for_user")
      throw new Error("unanswered_question: user has not answered the last question");
    if (session.state === "finalized")
      throw new Error("already finalized");
    if (session.state === "aborted")
      throw new Error("session is aborted");
    const canonical = JSON.stringify({ turns: session.turns });
    const digest = crypto.createHash(DIGEST_ALGORITHM).update(canonical).digest("hex");
    const now = nowIso8601Utc();
    const verified = {
      run_id: runId,
      finding_id: findingId,
      verifier_version: VERIFIER_VERSION,
      transcript_digest: `${DIGEST_ALGORITHM}:${digest}`,
      turns: session.turns,
      verified_at: now
    };
    const vp = verifiedPath(outputDir, runId, findingId);
    writeJsonAtomic(vp, verified);
    session.state = "finalized";
    session.updated_at = now;
    session.transcript_digest = `${DIGEST_ALGORITHM}:${digest}`;
    writeJsonAtomic(sp, session);
    upsertIndexEntry(outputDir, runId, findingId, {
      artifact_path: path5.join(outputDir, RUNS_DIR_NAME, runId, FINDINGS_DIR_NAME, findingId, REFINED_FILE_NAME),
      extractor_version: EXTRACTOR_VERSION,
      verified_at: now,
      verified: true,
      stage2_path: vp
    }, "preserve_refined_only");
    return {
      stage: 2,
      step: "finalize_verification",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      transcript_digest: `${DIGEST_ALGORITHM}:${digest}`,
      verified_path: vp
    };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}
function runAbortVerification(args) {
  try {
    const runId = String(args["run_id"] ?? "");
    const findingId = String(args["finding_id"] ?? "");
    const outputDir = String(args["output_dir"] ?? "");
    requireAbsolute(outputDir, "output_dir");
    const sp = sessionPath(outputDir, runId, findingId);
    if (!fs6.existsSync(sp))
      throw new Error("session not found");
    const session = JSON.parse(fs6.readFileSync(sp, "utf8"));
    if (session.state === "finalized")
      throw new Error("cannot abort a finalized session");
    const now = nowIso8601Utc();
    session.state = "aborted";
    session.aborted_at = now;
    session.abort_reason = args["reason"] ? String(args["reason"]) : void 0;
    session.updated_at = now;
    writeJsonAtomic(sp, session);
    return {
      stage: 2,
      step: "abort_verification",
      status: "ok",
      run_id: runId,
      finding_id: findingId,
      state: "aborted"
    };
  } catch (e) {
    return { stage: 2, status: "error", reason: String(e instanceof Error ? e.message : e) };
  }
}

// packages/mcp-servers/codebase/dist/tool-handlers.js
var SERVER_NAME_HANDLER = "ai-architect";
var SERVER_VERSION_HANDLER = "0.1.0-ts";
var PROTOCOL_VERSION_HANDLER = "2024-11-05";
var DEFAULT_SEARCH_LIMIT = 20;
async function handleToolCall(name, args, stageCount) {
  switch (name) {
    // Stage 0 — source: main.rs health_check handler
    case "health_check":
      return {
        server: SERVER_NAME_HANDLER,
        version: SERVER_VERSION_HANDLER,
        protocol: PROTOCOL_VERSION_HANDLER,
        implementation: "TypeScript (port of automatised-pipeline 0.0.9 Rust)",
        stages_registered: stageCount,
        backend: "PostgreSQL (cortex_agentic DB)",
        status: "ok"
      };
    // Stage 1 — source: main.rs stage 1a/1b handlers
    case "extract_finding":
      return runExtractFinding(args);
    case "refine_finding":
      return runRefineFinding(args);
    // Stage 2 — source: main.rs stage 2a/2b/2c/2d handlers
    case "start_verification":
      return runStartVerification(args);
    case "append_clarification":
      return runAppendClarification(args);
    case "finalize_verification":
      return runFinalizeVerification(args);
    case "abort_verification":
      return runAbortVerification(args);
    // Stage 3a — source: main.rs index_codebase handler
    case "index_codebase": {
      const codePath = String(args["path"] ?? "");
      const outputDir = String(args["output_dir"] ?? "");
      const lang = args["language"];
      const result = await indexCodebase(codePath, outputDir, lang && lang !== "auto" ? lang : void 0);
      return {
        status: "ok",
        graph_path: result.graphPath,
        graph_id: result.graphId,
        node_count: result.nodeCount,
        edge_count: result.edgeCount,
        files_indexed: result.filesIndexed,
        elapsed_ms: result.elapsedMs
      };
    }
    // Stage 3a — source: main.rs query_graph handler
    case "query_graph": {
      const graphPath = String(args["graph_path"] ?? "");
      const query = String(args["query"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const translated = cypherToSql(query, store.graphId);
      if (!translated) {
        return {
          status: "error",
          message: "Cannot translate Cypher query to SQL. Use SQL syntax for PostgreSQL backend.",
          hint: "Supported: MATCH (n:Label) RETURN ..., MATCH (n:Label) WHERE n.prop='val' RETURN ..."
        };
      }
      const result = await store.executeQuery(translated.sql, translated.params);
      return { columns: result.columns, rows: result.rows, row_count: result.rows.length };
    }
    // Stage 3a — source: main.rs get_symbol handler
    case "get_symbol": {
      const graphPath = String(args["graph_path"] ?? "");
      const qualifiedName = String(args["qualified_name"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await getSymbol(store, qualifiedName);
      if (!result)
        return { status: "not_found", qualified_name: qualifiedName };
      return { status: "ok", node: result.node, in_edges: result.inEdges, out_edges: result.outEdges };
    }
    // Stage 3b — source: main.rs resolve_graph handler
    case "resolve_graph": {
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await resolveGraph(store);
      return {
        status: "ok",
        imports_resolved: result.importsResolved,
        calls_resolved: result.callsResolved,
        impls_resolved: result.implsResolved,
        extends_resolved: result.extendsResolved,
        uses_resolved: result.usesResolved,
        total_edges: result.totalEdges,
        total_refs: result.totalRefs,
        unresolved_count: result.unresolved.length,
        elapsed_ms: result.elapsedMs
      };
    }
    // Stage 3c — source: main.rs cluster_graph handler
    case "cluster_graph": {
      const graphPath = String(args["graph_path"] ?? "");
      const gamma = typeof args["resolution_param"] === "number" ? args["resolution_param"] : 1;
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await clusterGraph(store, gamma);
      return {
        status: "ok",
        communities: result.communities,
        modularity: result.modularity,
        processes: result.processes,
        elapsed_ms: result.elapsedMs
      };
    }
    case "get_processes": {
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const procs = await getProcesses(store);
      return {
        status: "ok",
        processes: procs.map((p) => ({
          name: p.name,
          entry_point: p.entryPoint,
          entry_kind: p.entryKind,
          depth: p.depth,
          node_count: p.nodeCount
        }))
      };
    }
    case "get_impact": {
      const graphPath = String(args["graph_path"] ?? "");
      const qualifiedName = String(args["qualified_name"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await getImpact(store, qualifiedName);
      return { status: "ok", qualified_name: qualifiedName, communities: result.communities, processes: result.processes };
    }
    // Stage 3d — source: main.rs search_codebase handler
    case "search_codebase": {
      const graphPath = String(args["graph_path"] ?? "");
      const query = String(args["query"] ?? "");
      const limit = typeof args["limit"] === "number" ? args["limit"] : DEFAULT_SEARCH_LIMIT;
      const labelFilter = args["label_filter"];
      const store = await GraphStore.fromGraphPath(graphPath);
      const results = await searchGraph(store, query, { limit, label_filter: labelFilter, min_score: 0 });
      return { status: "ok", query, results };
    }
    case "get_context": {
      const graphPath = String(args["graph_path"] ?? "");
      const qualifiedName = String(args["qualified_name"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      try {
        const ctx = await getContext(store, qualifiedName);
        return { status: "ok", context: ctx };
      } catch (e) {
        const err = e;
        if (err.notFound) {
          return { status: "not_found", input: err.input ?? qualifiedName, did_you_mean: err.didYouMean ?? [] };
        }
        throw e;
      }
    }
    // Stage 3 all-in-one — source: main.rs analyze_codebase handler
    case "analyze_codebase": {
      const codePath = String(args["path"] ?? "");
      const outputDir = String(args["output_dir"] ?? "");
      const lang = args["language"];
      const gamma = typeof args["resolution_param"] === "number" ? args["resolution_param"] : 1;
      const indexResult = await indexCodebase(codePath, outputDir, lang && lang !== "auto" ? lang : void 0);
      const store = new GraphStore(indexResult.graphId);
      const resolveResult = await resolveGraph(store);
      const clusterResult = await clusterGraph(store, gamma);
      return {
        status: "ok",
        graph_path: indexResult.graphPath,
        graph_id: indexResult.graphId,
        index: {
          node_count: indexResult.nodeCount,
          edge_count: indexResult.edgeCount,
          files_indexed: indexResult.filesIndexed,
          elapsed_ms: indexResult.elapsedMs
        },
        resolve: {
          total_edges: resolveResult.totalEdges,
          total_refs: resolveResult.totalRefs,
          elapsed_ms: resolveResult.elapsedMs
        },
        cluster: {
          communities: clusterResult.communities,
          modularity: clusterResult.modularity,
          processes: clusterResult.processes,
          elapsed_ms: clusterResult.elapsedMs
        }
      };
    }
    // Stage 3e — source: main.rs detect_changes handler
    case "detect_changes": {
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      let analysis;
      if (args["diff_text"]) {
        analysis = await analyzeDiff(store, String(args["diff_text"]));
      } else {
        const codebasePath = String(args["codebase_path"] ?? "");
        const baseRef = String(args["base_ref"] ?? "HEAD~1");
        const headRef = String(args["head_ref"] ?? "HEAD");
        analysis = await analyzeGitDiff(store, codebasePath, baseRef, headRef);
      }
      return {
        status: "ok",
        files_changed: analysis.files_changed,
        symbols_affected: analysis.symbols_affected,
        communities_affected: analysis.communities_affected,
        processes_affected: analysis.processes_affected,
        risk_score: analysis.risk_score
      };
    }
    // Stage 3b-v2 — LSP stub (not ported)
    // source: lsp_resolver.rs / lsp_client.rs — requires native LSP client
    case "lsp_resolve":
      return {
        error: "tool lsp_resolve not yet ported, see TODO at packages/mcp-servers/codebase/src/index.ts",
        status: "not_ported",
        message: "LSP-enhanced resolution requires native LSP client. Use resolve_graph for static resolution."
      };
    // Stage 4 — source: main.rs prepare_prd_input handler
    case "prepare_prd_input": {
      const runId = String(args["run_id"] ?? "");
      const findingId = String(args["finding_id"] ?? "");
      const outputDir = String(args["output_dir"] ?? "");
      const graphPath = String(args["graph_path"] ?? "");
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await preparePrdInput(store, runId, findingId, outputDir);
      return {
        status: "ok",
        artifact_path: result.artifact_path,
        matched_symbol_count: result.matched_symbol_count,
        impacted_community_count: result.impacted_community_count,
        impacted_process_count: result.impacted_process_count
      };
    }
    // Stage 6 — source: main.rs validate_prd_against_graph handler
    case "validate_prd_against_graph": {
      const prdPath = String(args["prd_path"] ?? "");
      const graphPath = String(args["graph_path"] ?? "");
      const affectedSymbolsPath = args["affected_symbols_path"];
      const store = await GraphStore.fromGraphPath(graphPath);
      const result = await validatePrdAgainstGraph(store, prdPath, affectedSymbolsPath);
      return { status: "ok", ...result };
    }
    // Stage 8 — source: main.rs check_security_gates handler
    case "check_security_gates": {
      const graphPath = String(args["graph_path"] ?? "");
      const changedSymbols = Array.isArray(args["changed_symbols"]) ? args["changed_symbols"] : [];
      const store = await GraphStore.fromGraphPath(graphPath);
      const report = await checkSecurityGates(store, changedSymbols);
      if (args["output_dir"] && args["run_id"] && args["finding_id"]) {
        writeSecurityReport(String(args["output_dir"]), String(args["run_id"]), String(args["finding_id"]), report);
      }
      return { status: "ok", ...report };
    }
    // Stage 9 — source: main.rs verify_semantic_diff handler
    case "verify_semantic_diff": {
      const beforePath = String(args["before_graph_path"] ?? "");
      const afterPath = String(args["after_graph_path"] ?? "");
      const reportPath = args["report_path"];
      const result = await diffGraphs(beforePath, afterPath, reportPath);
      return {
        status: "ok",
        summary: result.summary,
        regression_score: result.regression_score,
        verdict: result.verdict,
        report: result.report
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// packages/mcp-servers/codebase/dist/tools-list.js
var TOOLS_LIST = {
  tools: [
    {
      name: "health_check",
      description: "Stage 0 \u2014 Healthcheck + handshake verification. Returns server identity, protocol version, and the registered stage count.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "extract_finding",
      description: "Stage 1a \u2014 Deterministic extraction. Normalizes one incoming finding to the canonical schema, writes stage-1.source.json + stage-1.extracted.json atomically.",
      inputSchema: {
        type: "object",
        required: ["finding", "output_dir"],
        additionalProperties: false,
        properties: {
          finding: { oneOf: [{ type: "object" }, { type: "string", pattern: "^/.+\\.json$" }] },
          output_dir: { type: "string", pattern: "^/.+" },
          run_id: { type: "string" }
        }
      }
    },
    {
      name: "refine_finding",
      description: "Stage 1b \u2014 Orchestrator-aware persistence. Reads stage-1.extracted.json, composes stage-1.refined.json.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir", "refined_prompt", "refinement"],
        additionalProperties: false,
        properties: {
          run_id: { type: "string" },
          finding_id: { type: "string" },
          output_dir: { type: "string", pattern: "^/.+" },
          refined_prompt: { type: "object" },
          refinement: { type: "object" }
        }
      }
    },
    {
      name: "start_verification",
      description: "Stage 2a \u2014 Create a clarification session for a refined finding.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir"],
        additionalProperties: false,
        properties: { run_id: { type: "string" }, finding_id: { type: "string" }, output_dir: { type: "string", pattern: "^/.+" } }
      }
    },
    {
      name: "append_clarification",
      description: "Stage 2b \u2014 Append one turn to stage-2.session.json.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir", "kind", "content"],
        additionalProperties: false,
        properties: {
          run_id: { type: "string" },
          finding_id: { type: "string" },
          output_dir: { type: "string", pattern: "^/.+" },
          kind: { enum: ["agent_question", "user_answer"] },
          content: { type: "string", minLength: 1 },
          meta: { type: "object" }
        }
      }
    },
    {
      name: "finalize_verification",
      description: "Stage 2c \u2014 Consume the user-ready signal. Computes transcript digest, writes stage-2.verified.json.",
      // source: main.rs stages/stage-2.md §12.3 — sha256 digest
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir"],
        additionalProperties: false,
        properties: { run_id: { type: "string" }, finding_id: { type: "string" }, output_dir: { type: "string", pattern: "^/.+" } }
      }
    },
    {
      name: "abort_verification",
      description: "Stage 2d \u2014 Kill a non-terminal session.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir"],
        additionalProperties: false,
        properties: { run_id: { type: "string" }, finding_id: { type: "string" }, output_dir: { type: "string", pattern: "^/.+" }, reason: { type: "string" } }
      }
    },
    {
      name: "index_codebase",
      description: "Stage 3a \u2014 Walk the directory, parse source files (TypeScript, Python, Rust), and persist a code-intelligence graph to PostgreSQL.",
      inputSchema: {
        type: "object",
        required: ["path", "output_dir"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          language: { type: "string", enum: ["auto", "rust", "python", "typescript", "javascript"], default: "auto" },
          output_dir: { type: "string" }
        }
      }
    },
    {
      name: "query_graph",
      description: "Stage 3a \u2014 Execute a Cypher-like query against an indexed code graph. Subset of Cypher translated to PostgreSQL SQL.",
      inputSchema: { type: "object", required: ["graph_path", "query"], additionalProperties: false, properties: { graph_path: { type: "string" }, query: { type: "string" } } }
    },
    {
      name: "get_symbol",
      description: "Stage 3a \u2014 Look up a symbol by qualified name. Returns node properties + incoming/outgoing edges.",
      inputSchema: { type: "object", required: ["graph_path", "qualified_name"], additionalProperties: false, properties: { graph_path: { type: "string" }, qualified_name: { type: "string" } } }
    },
    {
      name: "resolve_graph",
      description: "Stage 3b \u2014 Resolve cross-file edges (Imports, Calls, Implements, Extends, Uses). Runs after index_codebase.",
      inputSchema: { type: "object", required: ["graph_path"], additionalProperties: false, properties: { graph_path: { type: "string" } } }
    },
    {
      name: "cluster_graph",
      description: "Stage 3c \u2014 Louvain+C2 community detection + BFS process tracing. Requires resolve_graph to have been called first.",
      inputSchema: { type: "object", required: ["graph_path"], additionalProperties: false, properties: { graph_path: { type: "string" }, resolution_param: { type: "number", default: 1 } } }
    },
    {
      name: "get_processes",
      description: "Stage 3c \u2014 List all detected processes (execution flows from entry points). Requires cluster_graph.",
      inputSchema: { type: "object", required: ["graph_path"], additionalProperties: false, properties: { graph_path: { type: "string" } } }
    },
    {
      name: "get_impact",
      description: "Stage 3c \u2014 Blast-radius analysis for a symbol. Returns communities + processes it participates in.",
      inputSchema: { type: "object", required: ["graph_path", "qualified_name"], additionalProperties: false, properties: { graph_path: { type: "string" }, qualified_name: { type: "string" } } }
    },
    {
      name: "search_codebase",
      description: "Stage 3d \u2014 Hybrid search (PG FTS + TF-IDF + RRF). Returns ranked symbols. Requires analyze_codebase or cluster_graph.",
      inputSchema: {
        type: "object",
        required: ["graph_path", "query"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", default: 20 },
          label_filter: { type: "string", enum: ["Function", "Method", "Struct", "Enum", "Trait", "Module", "Constant", "TypeAlias"] }
        }
      }
    },
    {
      name: "get_context",
      description: "Stage 3d \u2014 Full symbol view: imports, calls, community, processes.",
      inputSchema: { type: "object", required: ["graph_path", "qualified_name"], additionalProperties: false, properties: { graph_path: { type: "string" }, qualified_name: { type: "string" } } }
    },
    {
      name: "analyze_codebase",
      description: "Stage 3 \u2014 All-in-one: index_codebase + resolve_graph + cluster_graph in sequence.",
      inputSchema: {
        type: "object",
        required: ["path", "output_dir"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          language: { type: "string", enum: ["auto", "rust", "python", "typescript", "javascript"], default: "auto" },
          output_dir: { type: "string" },
          resolution_param: { type: "number", default: 1 },
          lsp: { type: "boolean", default: false }
        }
      }
    },
    {
      name: "detect_changes",
      description: "Stage 3e \u2014 Git diff impact analysis. Maps changed lines to affected symbols, communities, processes.",
      inputSchema: {
        type: "object",
        required: ["graph_path"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string" },
          diff_text: { type: "string" },
          codebase_path: { type: "string" },
          base_ref: { type: "string", default: "HEAD~1" },
          head_ref: { type: "string", default: "HEAD" }
        }
      }
    },
    {
      name: "lsp_resolve",
      description: "Stage 3b-v2 \u2014 LSP-enhanced resolution. NOT YET PORTED \u2014 returns explicit error.",
      inputSchema: {
        type: "object",
        required: ["graph_path", "codebase_path"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string" },
          codebase_path: { type: "string" },
          language: { type: "string" },
          lsp_command: { type: "string" },
          timeout_ms: { type: "integer", default: 3e4 }
          // source: tool_schemas.rs lsp_resolve_schema timeout_ms default
        }
      }
    },
    {
      name: "prepare_prd_input",
      description: "Stage 4 \u2014 Bundle verified finding + graph intel into stage-4.prd_input.json.",
      inputSchema: {
        type: "object",
        required: ["run_id", "finding_id", "output_dir", "graph_path"],
        additionalProperties: false,
        properties: {
          run_id: { type: "string" },
          finding_id: { type: "string" },
          output_dir: { type: "string", pattern: "^/.+" },
          graph_path: { type: "string", pattern: "^/.+" }
        }
      }
    },
    {
      name: "validate_prd_against_graph",
      description: "Stage 6 \u2014 Validate PRD: symbol hallucination, community consistency, process-impact contradictions.",
      inputSchema: {
        type: "object",
        required: ["prd_path", "graph_path"],
        additionalProperties: false,
        properties: {
          prd_path: { type: "string", pattern: "^/.+" },
          graph_path: { type: "string", pattern: "^/.+" },
          affected_symbols_path: { type: "string", pattern: "^/.+" },
          output_dir: { type: "string", pattern: "^/.+" },
          run_id: { type: "string" },
          finding_id: { type: "string" }
        }
      }
    },
    {
      name: "check_security_gates",
      description: "Stage 8 \u2014 Graph-aware security gates: S1 auth-critical community, S2 unsafe symbol, S3 public API, S4 unresolved imports, S5 test gap.",
      inputSchema: {
        type: "object",
        required: ["graph_path", "changed_symbols"],
        additionalProperties: false,
        properties: {
          graph_path: { type: "string", pattern: "^/.+" },
          changed_symbols: { type: "array", items: { type: "string" } },
          output_dir: { type: "string", pattern: "^/.+" },
          run_id: { type: "string" },
          finding_id: { type: "string" }
        }
      }
    },
    {
      name: "verify_semantic_diff",
      description: "Stage 9 \u2014 Compare post-implementation graph against pre-implementation graph for regressions.",
      inputSchema: {
        type: "object",
        required: ["before_graph_path", "after_graph_path"],
        additionalProperties: false,
        properties: {
          before_graph_path: { type: "string", pattern: "^/.+" },
          after_graph_path: { type: "string", pattern: "^/.+" },
          report_path: { type: "string", pattern: "^/.+" }
        }
      }
    }
  ]
};

// packages/mcp-servers/codebase/dist/index.js
var SERVER_NAME = "ai-architect";
var SERVER_VERSION = "0.1.0-ts";
var PROTOCOL_VERSION = "2024-11-05";
var JSONRPC_PARSE_ERROR = -32700;
var JSONRPC_METHOD_NOT_FOUND = -32601;
var JSONRPC_INTERNAL_ERROR = -32603;
function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendResponse(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}
async function main() {
  try {
    await ensureSchema();
  } catch (e) {
    process.stderr.write(`codebase: PG schema init warning: ${e}
`);
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    void (async () => {
      const trimmed = line.trim();
      if (!trimmed)
        return;
      let req;
      try {
        req = JSON.parse(trimmed);
      } catch {
        sendError(null, JSONRPC_PARSE_ERROR, "Parse error");
        return;
      }
      const { id, method, params } = req;
      if (id === void 0 && !["initialize", "initialized"].includes(method))
        return;
      try {
        switch (method) {
          case "initialize":
            sendResponse(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
            });
            break;
          case "initialized":
            break;
          case "ping":
            sendResponse(id, {});
            break;
          case "tools/list":
            sendResponse(id, TOOLS_LIST);
            break;
          case "tools/call": {
            const p = params ?? {};
            const toolName = p.name ?? "";
            const toolArgs = p.arguments ?? {};
            const result = await handleToolCall(toolName, toolArgs, TOOLS_LIST.tools.length);
            sendResponse(id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            });
            break;
          }
          default:
            sendError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`codebase: error handling ${method}: ${msg}
`);
        sendError(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${msg}`);
      }
    })();
  });
  rl.on("close", () => {
    process.exit(0);
  });
}
main().catch((e) => {
  process.stderr.write(`codebase: fatal: ${e}
`);
  process.exit(1);
});
