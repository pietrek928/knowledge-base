#pragma once
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
  void build(const std::vector<std::string>& patterns);
  std::vector<ACHit> search(const std::string& text) const;

 private:
  struct Node {
    int next[256];
    int fail = 0;
    std::vector<int> out;
    Node() {
      for (int& x : next) x = -1;
    }
  };
  std::vector<Node> nodes_;
  std::vector<std::string> patterns_;
};

}  // namespace kb
