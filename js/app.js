let bluetoothDevice;
let charNotify;
let charWrite;
let timeCharWrite;

const DEFAULT_BLE_MTU = 20;
const TXT_ONLY_MAGIC = 0x0D;

const SERVICE_UUID = 0xfff0;
const CHAR_NOTIFY = "0000fff2-0000-1000-8000-00805f9b34fb"; // 0xFFF1
const CHAR_WRITE = "0000fff2-0000-1000-8000-00805f9b34fb"; // 0xFFF2

const TIME_SERVICE_UUID = 0x1805
const TIME_CHAR_WRITE = "00002a2b-0000-1000-8000-00805f9b34fb" //0x2a2b

const ACK_TYPE_LINK = 0x00;
const ACK_SUBTYPE_LINK_OK = 0x00;
const ACK_SUBTYPE_LINK_ERR = 0x01;

const ACK_TYPE_DRAW = 0x01;
const ACK_SUBTYPE_DRAW_OK = 0x00;
const ACK_SUBTYPE_DRAW_ERR = 0x01;

let bleMtuSize = DEFAULT_BLE_MTU;

function onScanButtonClick() {
  //let options = { filters: [{ services: [SERVICE_UUID] }, { name: 'SyncSign-Display-Lite' }, { name: 'SyncSign' }] };
  let options = { filters: [{ services: [SERVICE_UUID,TIME_SERVICE_UUID] },{ namePrefix: "greenbird-" },{ name: 'SyncSign-Display-Lite' }, { name: 'SyncSign' }] };

  bluetoothDevice = null;
  console.log("Requesting Bluetooth Device...");
  navigator.bluetooth
    .requestDevice(options)
    .then((device) => {
      bluetoothDevice = device;
      bluetoothDevice.addEventListener(
        "gattserverdisconnected",
        onDisconnected
      );
      return connect();
    })
    .catch((error) => {
      console.log("Argh! " + error);
    });
}

async function connect() {
  try {
    charWrite = null;
    charNotify = null;
    timeCharWrite = null;
    console.log("Connecting to Bluetooth Device...");
    let server = await bluetoothDevice.gatt.connect();
    console.log("> Bluetooth Device connected");
    console.log(">>> getPrimaryService", server.getPrimaryService(SERVICE_UUID));
    let service = await server.getPrimaryService(SERVICE_UUID);
    console.log("service", service);
    console.log("Getting Characteristic...");
    await enumerateGatt(server);

    if (charNotify) {
      console.log(`Found Characteristic: ${charNotify.uuid}`);
      await charNotify.startNotifications();
      console.log("> Notifications started");
      charNotify.addEventListener(
        "characteristicvaluechanged",
        handleNotifications
      );
    }
  } catch (error) {
    document.querySelector("#send").disabled = true;
    document.querySelector("#calibration-time").disabled = true;
    document.querySelector("#disconnect").disabled = true;
    console.error("Argh! " + error);
  }
}

async function enumerateGatt(server) {
  const services = await server.getPrimaryServices();
  // console.log("services", services);
  const sPromises = services.map(async (service) => {
    const characteristics = await service.getCharacteristics();
    const cPromises = characteristics.map(async (characteristic) => {
      // issue: https://github.com/WebBluetoothCG/web-bluetooth/issues/532
      // let descriptors = await characteristic.getDescriptors();
      // descriptors = descriptors.map(
      //   (descriptor) => `\t\t|_descriptor: ${descriptor.uuid}`
      // );
      // console.log("characteristic", characteristic)
      let descriptors = []
      descriptors.unshift(`\t|_characteristic: ${characteristic.uuid}`);
      if (characteristic.uuid === CHAR_NOTIFY) {
        charNotify = characteristic;
      }
      if (characteristic.uuid === CHAR_WRITE) {
        charWrite = characteristic;
        document.querySelector("#send").disabled = false;
        document.querySelector("#disconnect").disabled = false;
      }
      if (characteristic.uuid === TIME_CHAR_WRITE) {
        timeCharWrite = characteristic;
        document.querySelector("#calibration-time").disabled = false;
      }
      return descriptors.join("\n");
    });

    const descriptors = await Promise.all(cPromises);
    descriptors.unshift(`service: ${service.uuid}`);
    return descriptors.join("\n");
  });

  const result = await Promise.all(sPromises);
  console.log(result.join("\n"));
}

async function sendTextOnly(templateId, strings) {
  // [TXT_ONLY_MAGIC:1] [TotalLength:2] [TemplateId:1] [Reserved:3] [TextStrings:N]
  // Please note that the [TextStrings:N] is formated as:
  //      [LEN:1][TEXT:LEN] [LEN:1][TEXT:LEN]...[LEN:1][TEXT:LEN]

  let textData = new Uint8Array();
  for (i = 0; i < strings.length; i++) {
    if (strings[i].length <= 0x7f) {
      let enc = new TextEncoder();
      let len = new Uint8Array([enc.encode(strings[i]).length & 0x7f]);
      let text = enc.encode(strings[i]);
      let mergedArray = new Uint8Array(
        textData.length + len.length + text.length
      );
      mergedArray.set(textData);
      mergedArray.set(len, textData.length);
      mergedArray.set(text, textData.length + len.length);
      textData = mergedArray;
    }
  }
  totalLength = 1 + 3 + textData.length;

  let data = new Uint8Array([
    TXT_ONLY_MAGIC,
    totalLength & 0xff,
    (totalLength >> 8) & 0xff,
    templateId,
    0x00,
    0x00,
    0x00,
  ]);

  data = concatArrayBuffer(data, textData);
  console.log("data:", data);
  await writeDataChunk(data);
  console.log("sendTextOnly TPL ID=%d Strings=%s done", templateId, strings);
}

async function writeDataChunk(data) {
  // send data splited by MTU, then send the remaining in recursion

  if (data === "" || data === null || data === undefined) return;

  pkt = data.slice(0, bleMtuSize); // splite by MTU
  remain = data.slice(bleMtuSize);
  let typedArray = new Uint8Array(pkt);
  // console.log("   sending chunk", data);
  await charWrite
    .writeValueWithResponse(data.buffer)
    .then(async () => {
      console.log("data sent", typedArray.length);
      if (remain.length) {
        await writeDataChunk(remain);
      } else {
        console.log("All chunks(s) sent.");
      }
    })
    .catch((e) => {
      console.log(e);
    });
}

async function writeTimeDataChunk(data) {
  // send data splited by MTU, then send the remaining in recursion

  if (data === "" || data === null || data === undefined) return;

  pkt = data.slice(0, bleMtuSize); // splite by MTU
  remain = data.slice(bleMtuSize);
  let typedArray = new Uint8Array(pkt);
  console.log("sending chunk", typedArray.buffer);
  console.log(timeCharWrite)
  let sendTimeStatus = document.querySelector("#send-time-status");
  await timeCharWrite
    .writeValueWithResponse(typedArray.buffer)
    .then(async () => {
      console.log("data sent", typedArray.length);
      if (remain.length) {
        await writeTimeDataChunk(remain);
      } else {
        console.log("All chunks(s) sent.");
        sendTimeStatus.innerHTML = "Calibration Time Ok";
      }
    })
    .catch((e) => {
      sendTimeStatus.innerHTML = "Calibration Time Failed";
      console.log(e);
    });
}

function concatArrayBuffer(arrayOne, arrayTwo) {
  // a, b TypedArray of same type

  let mergedArray = new Uint8Array(arrayOne.length + arrayTwo.length);
  mergedArray.set(arrayOne);
  mergedArray.set(arrayTwo, arrayOne.length);
  return mergedArray;
}

function onDisconnectButtonClick() {
  if (!bluetoothDevice) {
    return;
  }
  console.log("Disconnecting from Bluetooth Device...");
  if (bluetoothDevice.gatt.connected) {
    if (charNotify) {
      charNotify
        .stopNotifications()
        .then((_) => {
          console.log("> Notifications stopped");
          charNotify.removeEventListener(
            "characteristicvaluechanged",
            handleNotifications
          );
        })
        .then((_) => {
          bluetoothDevice.gatt.disconnect();
          updateDeviceStatus("RESET", null);
        })
        .catch((error) => {
          console.log("Argh! " + error);
        });
    } else {
      bluetoothDevice.gatt.disconnect();
      updateDeviceStatus("RESET", null);
    }
  } else {
    console.log("> Bluetooth Device is already disconnected");
  }
}

function onDisconnected(event) {
  // Object event.target is Bluetooth Device getting disconnected.
  console.log("> Bluetooth Device disconnected");
  document.querySelector("#send").disabled = true;
  document.querySelector("#calibration-time").disabled = true;
  document.querySelector("#disconnect").disabled = true;
}

function handleNotifications(event) {
  let value = event.target.value;
  let data = [];
  for (let i = 0; i < value.byteLength; i++) {
    data.push("0x" + ("00" + value.getUint8(i).toString(16)).slice(-2));
  }
  const magic = data[0];
  if (magic != TXT_ONLY_MAGIC) {
    console.log("invalid response");
    return;
  }
  const payloadLength = data[1] | (data[2] << 8);
  const scope = data[3];
  const result = data[4];
  const errCode = data[5];
  if (scope == ACK_TYPE_LINK) {
    if (result == ACK_SUBTYPE_LINK_OK) {
      console.log("Data Sent OK");
      updateDeviceStatus("LINK", true);
    } else if (result == ACK_SUBTYPE_LINK_ERR) {
      console.log("Data Sent Failed", errCode);
      updateDeviceStatus("LINK", false);
    } else {
      console.log("Data Sent Result:", result, errCode);
      updateDeviceStatus("LINK", false);
    }
  } else if (scope == ACK_TYPE_DRAW) {
    if (result == ACK_SUBTYPE_DRAW_OK) {
      console.log("Draw Screen OK");
      updateDeviceStatus("DRAW", true);
    } else if (result == ACK_SUBTYPE_DRAW_ERR) {
      console.log("Draw Screen Failed", errCode);
      updateDeviceStatus("DRAW", false);
    } else {
      console.log("Draw Screen Result:", result, errCode);
      updateDeviceStatus("DRAW", false);
    }
  } else {
    console.log("scope:", scope, "result:", result, "errCode:", errCode);
  }
  console.log("> " + data.join(" "));
}

function updateDeviceStatus(scope, result) {
  let dataSent = document.querySelector("#data-sent");
  let drawScreen = document.querySelector("#draw-screen");
  if (scope === "LINK") {
    dataSent.innerHTML = result ? "Data Sent OK" : "Data Sent Failed";
    dataSent.className = result ? "text-success" : "text-danger";
  } else if (scope === "DRAW") {
    drawScreen.innerHTML = result ? "Draw Screen OK" : "Draw Screen Failed";
    drawScreen.className = result ? "text-success" : "text-danger";
  } else if (scope === "RESET") {
    drawScreen.innerHTML = "N";
    drawScreen.className = null;
    dataSent.innerHTML = "N";
    dataSent.className = null;
  }
}

async function onSendTextOnly() {
  let customField1 = document.querySelector("#custom-field1").value;
  let customField2 = document.querySelector("#custom-field2").value;
  let customField3 = document.querySelector("#custom-field3").value;
  let displayId = document.querySelector("#display-id").value;
  let qrcode = document.querySelector("#qrcode").value;
  let tplId = parseInt(document.querySelector("#tpl-id").value);
  if (tplId < 0 || tplId > 4) {
    tplId = 0
  }
  console.info("tplId=",tplId);
  try {
    updateDeviceStatus("RESET", null);
    await sendTextOnly(tplId, [
      customField1,
      customField2,
      displayId,
      customField3,
      qrcode,
    ]);
  } catch (error) {
    console.error(error);
  }
}

async function onSendTimeDate() {
  const today = new Date();
  //  [year]2B + [month]1B + [day]1B + [hour]1B + [minute]1B +[second]1B + [week]1B  + [fraction_256]1B: 00 + [adjust_reason]1B: 01
  let year =  today.getFullYear()
  let moth =  today.getMonth()
  let date =  today.getDate()
  let hours =  today.getHours()
  let minutes =  today.getMinutes()
  let seconds =  today.getSeconds()
  let day =  today.getDay()
  let dateTime = `${date}/${moth + 1}/${year} ${day} ${hours}:${minutes}:${seconds}`
  let drawTime = document.querySelector("#draw-time");
  drawTime.innerHTML = dateTime;
  let data = new Uint8Array([
      year & 0xff,
      year >> 8,
      moth + 1,
      date,
      hours,
      minutes,
      seconds,
      day,
      0x00,
      0x01,
  ]);
  try {
    // updateDeviceStatus("RESET", null);
    console.log("start send ...")
    // Send current time to display
    await writeTimeDataChunk(data);
  } catch (error) {
    console.error(error);
  }
  console.log(data);
}
