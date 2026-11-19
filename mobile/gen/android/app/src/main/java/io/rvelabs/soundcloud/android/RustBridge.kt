package io.rvelabs.soundcloud.android

import org.json.JSONObject

object RustBridge {
    init { System.loadLibrary("soundcloud_mobile_lib") }
    @JvmStatic private external fun nativeInit(directory: String, storage: Class<*>): String
    @JvmStatic private external fun nativeCall(command: String, arguments: String): String

    fun initialize(directory: String): JSONObject = decode(nativeInit(directory, SecretStorage::class.java)) as JSONObject

    fun call(command: String, args: JSONObject = JSONObject()): Any? =
        decode(nativeCall(command, args.toString()))

    private fun decode(text: String): Any? {
        val value = JSONObject(text)
        if (value.has("error")) throw IllegalStateException(value.getString("error"))
        return value.opt("ok").takeUnless { it === JSONObject.NULL }
    }
}
