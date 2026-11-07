use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub struct ResponseCache {
    entries: HashMap<String, Entry>,
    bytes: usize,
    limit: usize,
}

struct Entry {
    at: Instant,
    used: Instant,
    value: Value,
    cost: usize,
}

fn cost(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(text) => text.capacity(),
            Value::Array(items) => {
                items.capacity() * std::mem::size_of::<Value>()
                    + items
                        .iter()
                        .map(|item| cost(item) - std::mem::size_of::<Value>())
                        .sum::<usize>()
            }
            Value::Object(items) => items
                .iter()
                .map(|(key, item)| key.capacity() + 96 + cost(item))
                .sum(),
            _ => 0,
        }
}

impl ResponseCache {
    pub fn new(limit: usize) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            limit,
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
    pub fn get(&mut self, key: &str) -> Option<Value> {
        if self
            .entries
            .get(key)
            .is_some_and(|entry| entry.at.elapsed() >= Duration::from_secs(120))
        {
            self.remove(key);
        }
        let entry = self.entries.get_mut(key)?;
        entry.used = Instant::now();
        Some(entry.value.clone())
    }
    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.cost;
        }
    }
    pub fn insert(&mut self, key: String, value: Value) {
        let bytes = key.capacity() + 128 + cost(&value);
        self.remove(&key);
        if bytes > self.limit / 4 {
            return;
        }
        let expired: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.at.elapsed() >= Duration::from_secs(120))
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove(&key);
        }
        while self.bytes + bytes > self.limit || self.entries.len() >= 80 {
            let Some(old) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.remove(&old);
        }
        self.bytes += bytes;
        self.entries.insert(
            key,
            Entry {
                at: Instant::now(),
                used: Instant::now(),
                value,
                cost: bytes,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn respects_memory_budget_and_expires_without_a_new_insert() {
        let mut cache = ResponseCache::new(4096);
        for i in 0..100 {
            cache.insert(i.to_string(), Value::String("x".repeat(250)));
        }
        assert!(cache.bytes() <= 4096);
        assert!(cache.get("99").is_some());
        cache.insert("huge".into(), Value::String("x".repeat(3000)));
        assert!(cache.get("huge").is_none());
        cache.entries.get_mut("99").unwrap().at = Instant::now() - Duration::from_secs(121);
        assert!(cache.get("99").is_none());
        cache.clear();
        assert_eq!(cache.bytes(), 0);
    }
}
