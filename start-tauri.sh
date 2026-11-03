# 1. 退出旧实例
osascript -e 'quit app "9Router"'    # 不行就 pkill -f nine-router-desktop

# 2. 替换
ditto ./src-tauri/target/release/bundle/macos/9Router.app /Applications/9Router.app

# 3. 开放局域网
echo 0.0.0.0 > ~/.9router/hostname

# 4. 启动
open -a 9Router