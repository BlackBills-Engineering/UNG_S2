import { EventEmitter } from "events";
import SerialPort from "serialport";
import crc16 from "./crc16.js";

// ---- константы протокола ---------------------------------------------
export const PumpStatus = {
  NOT_PROGRAMMED: 0,
  RESET: 1,
  AUTHORIZED: 2,
  FILLING: 4,
  FILLED: 5,
  PRESET_REACHED: 6,
  SWITCHED_OFF: 7,
};

export const CMD = {
  RETURN_STATUS: 0x00,
  RESET: 0x05,
  AUTHORISE: 0x06,
  STOP: 0x08,
};

// ---- вспомогалка BCD ---------------------------------------------------
function toBCD(val, bytes = 4) {
  const s = Math.round(val)
    .toString()
    .padStart(bytes * 2, "0");
  return s.match(/../g).map((hex) => parseInt(hex, 16));
}
function fromBCD(arr) {
  return parseInt(Buffer.from(arr).toString("hex"), 16);
}

// ---- класс мастера -----------------------------------------------------
export class MKR5Master extends EventEmitter {
  constructor(portPath = "/dev/ttyS0", baudRate = 9600) {
    super();
    this.port = new SerialPort(portPath, {
      baudRate,
      dataBits: 8,
      parity: "odd",
      stopBits: 1,
    });
    this.buf = [];
    this.port.on("data", (c) => this._collect(c));
    this._poll = setInterval(() => this.pollAll(), 1000);
  }

  // ---------- публичные методы ----------
  pollAll() {
    for (let a = 0x50; a <= 0x6f; a++) {
      this.send(a, [0x01, 0x01, CMD.RETURN_STATUS]);
    }
  }
  authorize(addr, { nozzle = 1, volume, amount } = {}) {
    this.send(addr, [0x02, 0x01, nozzle]); // CD2 список пистолетов
    if (volume) this.send(addr, [0x03, 0x04, ...toBCD(volume)]);
    if (amount) this.send(addr, [0x04, 0x04, ...toBCD(amount)]);
    this.send(addr, [0x01, 0x01, CMD.AUTHORISE]); // CD1 AUTHORISE
  }
  stop(addr) {
    this.send(addr, [0x01, 0x01, CMD.STOP]);
  }
  reset(addr) {
    this.send(addr, [0x01, 0x01, CMD.RESET]);
  }

  // ---------- построение кадра ----------
  send(addr, payload) {
    const frame = [addr, 0x11, ...payload]; // ADR, CTRL=0x11
    const crc = crc16(frame);
    frame.push(crc & 0xff, crc >> 8, 0x03, 0xfa); // CRC, ETX, SF
    this.port.write(Buffer.from(frame));
  }

  // ---------- парсер потока ------------
  _collect(chunk) {
    for (const b of chunk) {
      this.buf.push(b);
      if (b === 0xfa) {
        this._parseFrame(this.buf);
        this.buf = [];
      }
    }
  }
  _parseFrame(bytes) {
    if (bytes.length < 7) return;
    const sf = bytes.pop(),
      etx = bytes.pop();
    const crcHi = bytes.pop(),
      crcLo = bytes.pop();
    const crcOk =
      ((crc16(bytes) >> 8) & 0xff) === crcHi && (crc16(bytes) & 0xff) === crcLo;
    if (!crcOk) return;

    const [adr, ctrl, trans, lng, ...data] = bytes;

    // DC1 — статус/объём/сумма
    if (trans === 0x81) {
      const dcc = data[0];
      if (dcc === 0x00 && lng >= 2)
        this.emit("update", { addr: adr, data: { status: data[1] } });
      if (dcc === 0x04 && lng >= 8) {
        const vol = fromBCD(data.slice(1, 5)) / 100;
        const amt = fromBCD(data.slice(5, 9)) / 100;
        this.emit("update", { addr: adr, data: { volume: vol, amount: amt } });
      }
    }
    // DC3 — пистолет + цена
    if (trans === 0x83) {
      const [nozio, ...priceBCD] = data.slice(1);
      this.emit("update", {
        addr: adr,
        data: {
          nozzle: nozio & 0x0f,
          inUse: !!(nozio & 0x10),
          price: fromBCD(priceBCD) / 100,
        },
      });
    }
  }
}
