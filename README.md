# Cisco Camera Port Tracer

Ứng dụng web chạy cục bộ để tìm switch và port vật lý của camera từ địa chỉ IP. Ứng dụng **không dùng AI**, không dùng cloud và không lưu mật khẩu.

## Chức năng

Ứng dụng có hai tab:

1. **Tìm port** — dò đường đi của một IP (camera/thiết bị) xuyên qua nhiều tầng switch Cisco bằng ARP, MAC address-table, CDP/LLDP để tìm switch và port vật lý cuối cùng.
2. **Config Manager** — quản lý danh sách switch (thêm/sửa/xóa/nhập CSV), soạn lệnh cấu hình và thực thi hàng loạt (Test Ping, Test SSH, Áp dụng cấu hình), kèm lưu/mở dự án JSON. Credential từng switch được lưu trong trình duyệt (plaintext) giống app desktop gốc — chỉ nên dùng trong mạng quản trị tin cậy.

## Luồng xử lý

1. SSH vào Core switch.
2. Chạy `show ip arp <CAMERA-IP>` để lấy MAC và VLAN.
3. Chạy `show mac address-table address <MAC>` để lấy port.
4. Dùng CDP, sau đó LLDP, để xác định switch kế tiếp.
   - Nếu MAC nằm trên `Port-channel`, app chạy `show etherchannel summary`, lấy member forwarding `(P)` và dò CDP/LLDP trên từng physical member.
5. SSH vào switch kế tiếp và lặp lại cho đến khi không còn switch downstream.
6. Trả về thiết bị và port cuối cùng của camera.

Nếu MAC nằm trên port có `Operational Mode: ... access`, app kết luận ngay đó là port camera và không chạy CDP/LLDP trên port access. CDP/LLDP chỉ được dùng cho trunk, Port-channel hoặc uplink chưa xác định.

Ứng dụng hỗ trợ đường đi nhiều tầng như `CORE → DISTRIBUTION → ACCESS → CAMERA`.

## Dò danh sách camera

- Nhập nhiều IP, mỗi IP một dòng, hoặc import file `.txt` / `.csv`.
- App dò tuần tự để tránh tạo tải SSH đồng thời lên hệ thống switch.
- Một camera lỗi không làm dừng các camera còn lại.
- Bảng kết quả hiển thị IP, MAC, VLAN, switch đích, port, số hop và trạng thái.
- Nút `Xuất CSV` lưu cả đường đi qua các switch và nội dung lỗi của từng camera.
- Mỗi lần hỗ trợ tối đa 1000 IP; IP trùng và dòng sai được đánh dấu riêng.

## Yêu cầu

- Node.js 20 trở lên.
- Máy chạy ứng dụng truy cập được TCP/22 tới tất cả switch.
- Cùng một tài khoản SSH truy cập được các switch trong đường đi.
- Tài khoản có quyền chạy lệnh `show`; nhập Enable password nếu thiết bị yêu cầu.
- CDP hoặc LLDP phải cung cấp IP quản trị của switch kế tiếp.

## Cài đặt và chạy

Cấu hình tài khoản dùng chung cho Core và toàn bộ switch downstream:

```powershell
.\setup-credentials.ps1
```

Script mã hóa username, password và enable password bằng Windows DPAPI. File mã hóa chỉ giải mã được bởi đúng Windows user trên máy đã tạo nó. Không lưu credential vào `.env` dạng plaintext.

Cách chạy trên Windows: nhấp đúp `start-app.cmd`. Launcher giải mã credential vào biến môi trường **chỉ của tiến trình app**, sau đó mở trình duyệt.

Hoặc chạy thủ công:

```powershell
npm install
npm start
```

Mở `http://127.0.0.1:3030` trên trình duyệt.

Chạy kiểm thử:

```powershell
npm test
```

## Chạy trên máy chủ bằng Docker

Máy chủ cần Docker Engine với Docker Compose plugin và quyền kết nối TCP/22 tới các switch. App chạy trong container Linux; credential Windows DPAPI trong config/credentials.json không dùng được trong container.

Tạo các file secret trên máy chủ. Thư mục secrets/ đã được Git bỏ qua; không commit nội dung các file này:

~~~sh
mkdir -p secrets
touch secrets/ssh_username secrets/ssh_password secrets/ssh_private_key \
  secrets/ssh_key_passphrase secrets/enable_password
chmod 600 secrets/*
nano secrets/ssh_username
nano secrets/ssh_password
~~~

Điền username và một trong hai cách xác thực: mật khẩu trong ssh_password, hoặc private key trong ssh_private_key. Nếu dùng key có passphrase, điền ssh_key_passphrase; nếu switch yêu cầu enable password, điền enable_password. Các file không dùng có thể để trống. Bảo vệ thư mục secrets/ trên máy chủ và chỉ cấp quyền đọc cho quản trị viên.

Pull mã nguồn rồi build và chạy:

~~~sh
git clone <URL-repository>
cd <thư-mục-repository>
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3030/api/health
~~~

Compose chỉ publish cổng trên 127.0.0.1 của máy chủ. Từ máy quản trị, dùng SSH tunnel rồi mở http://127.0.0.1:3030:

~~~sh
ssh -L 3030:127.0.0.1:3030 <user>@<server>
~~~

Nếu cần đặt reverse proxy trên cùng máy chủ, proxy tới 127.0.0.1:3030 và bật xác thực ở proxy. App không có màn hình đăng nhập; không publish trực tiếp ra Internet hoặc mạng người dùng.

Xem log và cập nhật phiên bản:

~~~sh
docker compose logs -f app
git pull
docker compose up -d --build
~~~

Compose mount credential dạng secret file vào container; entrypoint đọc file rồi chạy Node với user không đặc quyền. Docker secrets dạng file trên một máy chủ vẫn được lưu trên filesystem host, vì vậy cần giữ quyền truy cập thư mục chặt chẽ.

## Đăng nhập quản trị

Ứng dụng có màn hình đăng nhập quản trị (tài khoản admin dùng chung). Mặc định là `admin` / `admin` khi chưa cấu hình — hãy đổi ngay:

- **Windows:** chạy `setup-credentials.ps1` để lưu `adminUsername` / `adminPassword` (mã hóa DPAPI), launcher `start-app.ps1` sẽ giải mã vào biến môi trường `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
- **Docker:** đặt nội dung vào secret `secrets/admin_username` và `secrets/admin_password`.
- **Thủ công:** đặt biến môi trường `ADMIN_USERNAME` / `ADMIN_PASSWORD` trước khi chạy `npm start`.

Phiên đăng nhập dùng cookie `HttpOnly` + `SameSite=Strict`, hết hạn sau 8 giờ. Toàn bộ API (trừ `/api/health`, `/api/session`, `/api/login`) đều yêu cầu đăng nhập.

## Bảo mật

- Server mặc định chỉ lắng nghe trên `127.0.0.1`, không mở ra LAN.
- Mật khẩu và private key chỉ tồn tại trong bộ nhớ trong lúc dò.
- Trình duyệt chỉ lưu Core IP, username, timeout và giới hạn hop; không lưu bí mật.
- SSH host key chưa được pin. Chỉ chạy ứng dụng trong mạng quản trị đáng tin cậy.
- Ứng dụng ưu tiên thuật toán SSH hiện đại. Nếu switch Cisco cũ không tương thích, ứng dụng tự thử lại bằng KEX/cipher legacy (SHA-1/CBC) trong mạng quản trị nội bộ.

## Giới hạn hiện tại

- Port-channel có thể cần bật CDP/LLDP trên logical interface hoặc bổ sung xử lý member port tùy thiết kế mạng.
- Nếu switch kế tiếp không quảng bá IP quản trị qua CDP/LLDP, ứng dụng sẽ dừng và báo rõ vị trí.
- Camera hoặc thiết bị đầu cuối quảng bá LLDP không được truy cập SSH nếu không được nhận diện là switch/bridge/router.
