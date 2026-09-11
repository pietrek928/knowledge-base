#include "trigrams.hpp"

#include <algorithm>
#include <unordered_map>

namespace kb {

TrigramMap build_trigrams(const std::string &text) {
  TrigramMap map;
  const int n = static_cast<int>(text.size());
  if (n < 3)
    return map;
  for (int i = 0; i + 2 < n; ++i) {
    uint32_t key = pack_trigram(text[i], text[i + 1], text[i + 2]);
    auto &v = map[key];
    if (v.empty() || v.back() != i)
      v.push_back(i);
  }
  return map;
}

std::vector<int> trigram_candidates(const TrigramMap &index, const std::string &pattern,
                                    int max_candidates) {
  const int m = static_cast<int>(pattern.size());
  if (m < 3) {
    std::vector<int> all;
    // short patterns: return empty — caller should use SA
    return all;
  }
  std::unordered_map<int, int> votes;
  for (int i = 0; i + 2 < m; ++i) {
    uint32_t key = pack_trigram(pattern[i], pattern[i + 1], pattern[i + 2]);
    auto it = index.find(key);
    if (it == index.end())
      continue;
    for (int pos : it->second) {
      int start = pos - i;
      if (start >= 0)
        votes[start] += 1;
    }
  }
  std::vector<std::pair<int, int>> scored;
  scored.reserve(votes.size());
  for (auto &[pos, c] : votes)
    scored.emplace_back(c, pos);
  std::sort(scored.begin(), scored.end(), [](auto &a, auto &b) {
    if (a.first != b.first)
      return a.first > b.first;
    return a.second < b.second;
  });
  std::vector<int> out;
  for (auto &[c, pos] : scored) {
    out.push_back(pos);
    if (static_cast<int>(out.size()) >= max_candidates)
      break;
  }
  return out;
}

} // namespace kb
