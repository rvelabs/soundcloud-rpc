use futures_util::StreamExt;
use serde_json::Value;

pub async fn bytes(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("Response exceeds size limit".into());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Connection interrupted")?;
        if body.len() + chunk.len() > limit {
            return Err("Response exceeds size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
pub async fn json(response: reqwest::Response, limit: usize) -> Result<Value, String> {
    serde_json::from_slice(&bytes(response, limit).await?)
        .map_err(|_| "Invalid JSON response".into())
}
