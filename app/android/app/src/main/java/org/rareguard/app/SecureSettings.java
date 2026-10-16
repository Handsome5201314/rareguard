package org.rareguard.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureSettings {
    private static final String ALIAS="rareguard-credential-v1";
    private final SharedPreferences prefs;
    SecureSettings(Context c){
        prefs=c.getSharedPreferences("secure",Context.MODE_PRIVATE);
        // The 0.2.x Hermes credential is no longer a valid source for this app.
        prefs.edit().remove("url").remove("token").remove("iv").apply();
    }
    org.json.JSONObject dravet() throws Exception {
        String data=prefs.getString("dravet_token",null);if(data==null)return null;
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(prefs.getString("dravet_iv",""),Base64.NO_WRAP)));
        return new org.json.JSONObject(new String(cipher.doFinal(Base64.decode(data,Base64.NO_WRAP)),java.nio.charset.StandardCharsets.UTF_8));
    }
    void saveDravet(org.json.JSONObject binding) throws Exception {
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        boolean saved=prefs.edit().putString("dravet_token",Base64.encodeToString(cipher.doFinal(binding.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)),Base64.NO_WRAP))
            .putString("dravet_iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).commit();
        if(!saved)throw new IllegalStateException("配对凭据未保存，请检查设备存储空间并生成新的配对包");
    }
    private SecretKey key() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(ALIAS)) {
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();
        }
        return (SecretKey)store.getKey(ALIAS,null);
    }
}
