package io.rvelabs.soundcloud.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SecretStorage {
    private const val alias = "soundcloud-local-settings-v1"

    @JvmStatic @Synchronized
    fun crypt(path: String, content: ByteArray, write: Boolean): ByteArray {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
        ).apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val file = File(path)
        if (!write) {
            val encrypted = file.readBytes()
            require(encrypted.size in 29..64_000) { "Invalid encrypted settings" }
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, encrypted.copyOfRange(0, 12)))
            return cipher.doFinal(encrypted.copyOfRange(12, encrypted.size))
        }
        require(content.size <= 32_000)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val temporary = File(path + ".tmp")
        temporary.outputStream().use { output ->
            output.write(cipher.iv)
            output.write(cipher.doFinal(content))
            output.fd.sync()
        }
        check(temporary.renameTo(file)) { "Could not commit encrypted settings" }
        return byteArrayOf()
    }
}
