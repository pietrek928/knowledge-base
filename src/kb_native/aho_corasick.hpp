#pragma once
#include <array>
#include <string>
#include <utility>
#include <vector>

namespace kb {

struct ACHit {
  int pattern_id;
  int start;
  int end;
};

class AhoCorasick {
public:
  void build(const std::vector<std::string> &patterns);
  std::vector<ACHit> search(const std::string &text) const;

private:
  struct Node {
    std::array<int, 256> next;
    int fail = 0;
    std::vector<int> out;
    Node() { next.fill(-1); }
  };
  std::vector<Node> nodes_;
  std::vector<std::string> patterns_;
};

} // namespace kb
