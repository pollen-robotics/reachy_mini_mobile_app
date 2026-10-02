package com.pollen_robotics.spp

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class ListenArgs {
    var channel: Channel? = null
}

@InvokeArg
class ConnectArgs {
    var address: String = ""
}

@InvokeArg
class WriteArgs {
    var data: String = ""
}

/**
 * One Bluetooth Classic serial (SPP / RFCOMM) link, used to drive the Reachy
 * Mini wheeled base directly from the phone. Events go to the channel given
 * to `listen`: {type: "line", line} for every received line, and
 * {type: "disconnected", reason} when the link drops.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "bluetooth"),
    ],
)
class SppPlugin(private val activity: Activity) : Plugin(activity) {
    private val sppUuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    // Connect and writes run in order on one thread, off the UI thread.
    private val io = Executors.newSingleThreadExecutor()
    private var events: Channel? = null

    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var output: OutputStream? = null

    private fun adapter(): BluetoothAdapter? =
        (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun needsPermission(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getPermissionState("bluetooth") != PermissionState.GRANTED

    private fun emit(obj: JSObject) {
        try {
            events?.send(obj)
        } catch (_: Exception) {
        }
    }

    @Command
    fun listen(invoke: Invoke) {
        events = invoke.parseArgs(ListenArgs::class.java).channel
        invoke.resolve()
    }

    @Command
    fun bonded(invoke: Invoke) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", invoke, "bondedAfterPermission")
            return
        }
        listBonded(invoke)
    }

    @PermissionCallback
    fun bondedAfterPermission(invoke: Invoke) {
        if (needsPermission()) invoke.reject("Bluetooth permission denied") else listBonded(invoke)
    }

    @SuppressLint("MissingPermission")
    private fun listBonded(invoke: Invoke) {
        val adapter = adapter() ?: return invoke.reject("No Bluetooth on this phone")
        if (!adapter.isEnabled) return invoke.reject("Bluetooth is off")
        val list = JSArray()
        for (d in adapter.bondedDevices) {
            list.put(JSObject().put("name", d.name ?: "").put("address", d.address))
        }
        invoke.resolve(JSObject().put("devices", list))
    }

    @Command
    fun connect(invoke: Invoke) {
        if (needsPermission()) {
            requestPermissionForAlias("bluetooth", invoke, "connectAfterPermission")
            return
        }
        startConnect(invoke)
    }

    @PermissionCallback
    fun connectAfterPermission(invoke: Invoke) {
        if (needsPermission()) invoke.reject("Bluetooth permission denied") else startConnect(invoke)
    }

    @SuppressLint("MissingPermission")
    private fun startConnect(invoke: Invoke) {
        val address = invoke.parseArgs(ConnectArgs::class.java).address
        val adapter = adapter() ?: return invoke.reject("No Bluetooth on this phone")
        if (!adapter.isEnabled) return invoke.reject("Bluetooth is off")
        io.execute {
            closeSocket()
            try {
                adapter.cancelDiscovery()
                val device = adapter.getRemoteDevice(address)
                val s = openSocket(device)
                socket = s
                output = s.outputStream
                startReader(s)
                invoke.resolve()
            } catch (e: Exception) {
                closeSocket()
                invoke.reject("Could not connect: ${e.message}")
            }
        }
    }

    /** Standard SPP UUID first; ESP32 BluetoothSerial also answers on RFCOMM channel 1. */
    @SuppressLint("MissingPermission")
    private fun openSocket(device: BluetoothDevice): BluetoothSocket {
        try {
            val s = device.createRfcommSocketToServiceRecord(sppUuid)
            s.connect()
            return s
        } catch (first: IOException) {
            val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
            val s = m.invoke(device, 1) as BluetoothSocket
            try {
                s.connect()
            } catch (e: IOException) {
                try { s.close() } catch (_: IOException) {}
                throw IOException("${first.message}; channel 1: ${e.message}")
            }
            return s
        }
    }

    private fun startReader(s: BluetoothSocket) {
        Thread({
            val input = s.inputStream
            val buf = ByteArray(1024)
            val line = StringBuilder()
            var reason = "closed"
            try {
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    for (i in 0 until n) {
                        val c = (buf[i].toInt() and 0xff).toChar()
                        if (c == '\n' || c == '\r') {
                            if (line.isNotEmpty()) {
                                emit(JSObject().put("type", "line").put("line", line.toString()))
                                line.setLength(0)
                            }
                        } else if (line.length < 512) {
                            line.append(c)
                        }
                    }
                }
            } catch (e: IOException) {
                reason = e.message ?: "read failed"
            }
            // Only report it if this socket is still the current one (not a
            // deliberate disconnect or a replaced link).
            if (socket === s) {
                closeSocket()
                emit(JSObject().put("type", "disconnected").put("reason", reason))
            }
        }, "spp-reader").apply { isDaemon = true }.start()
    }

    @Command
    fun write(invoke: Invoke) {
        val data = invoke.parseArgs(WriteArgs::class.java).data
        io.execute {
            val out = output
            if (out == null) {
                invoke.reject("Not connected")
                return@execute
            }
            try {
                out.write(data.toByteArray(Charsets.US_ASCII))
                out.flush()
                invoke.resolve()
            } catch (e: IOException) {
                invoke.reject("Write failed: ${e.message}")
            }
        }
    }

    @Command
    fun disconnect(invoke: Invoke) {
        io.execute {
            closeSocket()
            invoke.resolve()
        }
    }

    private fun closeSocket() {
        val s = socket
        socket = null
        output = null
        try {
            s?.close()
        } catch (_: IOException) {
        }
    }
}
