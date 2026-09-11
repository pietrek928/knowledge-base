#include "aho_corasick.hpp"

#include <queue>

namespace kb {

void AhoCorasick::build(const std::vector<std::string> &patterns) {
  patterns_ = patterns;
  nodes_.clear();
  nodes_.emplace_back();
  for (int pid = 0; pid < static_cast<int>(patterns.size()); ++pid) {
    const auto &p = patterns[pid];
    int v = 0;
    for (unsigned char ch : p) {
      if (nodes_[v].next[ch] == -1) {
        nodes_[v].next[ch] = static_cast<int>(nodes_.size());
        nodes_.emplace_back();
      }
      v = nodes_[v].next[ch];
    }
    nodes_[v].out.push_back(pid);
  }
  std::queue<int> q;
  for (int c = 0; c < 256; ++c) {
    int u = nodes_[0].next[c];
    if (u != -1) {
      nodes_[u].fail = 0;
      q.push(u);
    } else {
      nodes_[0].next[c] = 0;
    }
  }
  while (!q.empty()) {
    int v = q.front();
    q.pop();
    for (int c = 0; c < 256; ++c) {
      int u = nodes_[v].next[c];
      if (u == -1) {
        nodes_[v].next[c] = nodes_[nodes_[v].fail].next[c];
        continue;
      }
      nodes_[u].fail = nodes_[nodes_[v].fail].next[c];
      auto &fout = nodes_[nodes_[u].fail].out;
      nodes_[u].out.insert(nodes_[u].out.end(), fout.begin(), fout.end());
      q.push(u);
    }
  }
}

std::vector<ACHit> AhoCorasick::search(const std::string &text) const {
  std::vector<ACHit> hits;
  if (nodes_.empty())
    return hits;
  int v = 0;
  for (int i = 0; i < static_cast<int>(text.size()); ++i) {
    unsigned char ch = static_cast<unsigned char>(text[i]);
    v = nodes_[v].next[ch];
    for (int pid : nodes_[v].out) {
      int len = static_cast<int>(patterns_[pid].size());
      ACHit h;
      h.pattern_id = pid;
      h.start = i - len + 1;
      h.end = i + 1;
      hits.push_back(h);
    }
  }
  return hits;
}

} // namespace kb
