//! Raw L2CAP ATT protocol client for Linux.
//!
//! Bypasses BlueZ D-Bus Connect() which fails on dual-mode devices (e.g. Raspberry Pi)
//! that advertise BR/EDR profiles. Uses direct L2CAP sockets like gatttool.

use crate::{Error, Result};
use std::collections::HashMap;
use uuid::Uuid;

const AF_BLUETOOTH: i32 = 31;
const BTPROTO_L2CAP: i32 = 0;
const SOL_BLUETOOTH: i32 = 274;
const BT_SECURITY: i32 = 4;
const ATT_CID: u16 = 4;
const BDADDR_LE_PUBLIC: u8 = 1;
const BDADDR_LE_RANDOM: u8 = 2;

// ATT opcodes
const ATT_OP_ERROR_RSP: u8 = 0x01;
const ATT_OP_MTU_REQ: u8 = 0x02;
const ATT_OP_MTU_RSP: u8 = 0x03;
const ATT_OP_READ_BY_TYPE_REQ: u8 = 0x08;
const ATT_OP_READ_BY_TYPE_RSP: u8 = 0x09;
const ATT_OP_READ_REQ: u8 = 0x0A;
const ATT_OP_READ_RSP: u8 = 0x0B;
const ATT_OP_WRITE_REQ: u8 = 0x12;
const ATT_OP_WRITE_RSP: u8 = 0x13;
const ATT_OP_READ_BY_GROUP_TYPE_REQ: u8 = 0x10;
const ATT_OP_READ_BY_GROUP_TYPE_RSP: u8 = 0x11;
const ATT_OP_WRITE_CMD: u8 = 0x52;

const ATT_ERR_ATTR_NOT_FOUND: u8 = 0x0A;

#[derive(Debug, Clone)]
pub struct AttService {
    pub uuid: Uuid,
    pub start_handle: u16,
    pub end_handle: u16,
}

#[derive(Debug, Clone)]
pub struct AttCharacteristic {
    pub uuid: Uuid,
    pub _handle: u16,
    pub value_handle: u16,
    pub properties: u8,
}

#[derive(Debug)]
pub struct RawAttConnection {
    sock: i32,
    mtu: u16,
    services: Vec<AttService>,
    characteristics: Vec<AttCharacteristic>,
    // Map from (service_uuid, char_uuid) -> value_handle
    handle_map: HashMap<(Uuid, Uuid), u16>,
}

impl RawAttConnection {
    /// Establish a raw LE ATT connection to the given Bluetooth address.
    pub fn connect(bdaddr: [u8; 6], is_random: bool) -> Result<Self> {
        let addr_type = if is_random { BDADDR_LE_RANDOM } else { BDADDR_LE_PUBLIC };

        let sock = unsafe {
            #[repr(C)]
            struct BtSecurity {
                level: u8,
                key_size: u8,
            }

            let sock = libc::socket(AF_BLUETOOTH, libc::SOCK_SEQPACKET, BTPROTO_L2CAP);
            if sock < 0 {
                return Err(Error::Other(
                    format!("socket() failed: {}", std::io::Error::last_os_error()).into(),
                ));
            }

            // BT_SECURITY_LOW
            let sec = BtSecurity { level: 1, key_size: 0 };
            if libc::setsockopt(
                sock,
                SOL_BLUETOOTH,
                BT_SECURITY,
                &sec as *const BtSecurity as *const libc::c_void,
                2,
            ) < 0
            {
                let err = std::io::Error::last_os_error();
                libc::close(sock);
                return Err(Error::Other(
                    format!("setsockopt(BT_SECURITY) failed: {}", err).into(),
                ));
            }

            // sockaddr_l2 layout (little-endian Linux):
            //   [0..2]   l2_family     (u16 LE)
            //   [2..4]   l2_psm        (u16 LE) = 0 for ATT
            //   [4..10]  l2_bdaddr     ([u8;6])
            //   [10..12] l2_cid        (u16 LE) = ATT_CID
            //   [12]     l2_bdaddr_type (u8)
            let mut local: [u8; 14] = [0u8; 14];
            local[0..2].copy_from_slice(&(AF_BLUETOOTH as u16).to_le_bytes());
            local[10..12].copy_from_slice(&ATT_CID.to_le_bytes());
            local[12] = addr_type;
            if libc::bind(sock, local.as_ptr() as *const libc::sockaddr, 14) < 0 {
                let err = std::io::Error::last_os_error();
                libc::close(sock);
                return Err(Error::Other(format!("bind() failed: {}", err).into()));
            }

            let mut remote: [u8; 14] = [0u8; 14];
            remote[0..2].copy_from_slice(&(AF_BLUETOOTH as u16).to_le_bytes());
            remote[4..10].copy_from_slice(&bdaddr);
            remote[10..12].copy_from_slice(&ATT_CID.to_le_bytes());
            remote[12] = addr_type;

            let ret = libc::connect(sock, remote.as_ptr() as *const libc::sockaddr, 14);
            if ret < 0 {
                let errno = *libc::__errno_location();
                if errno == libc::EINPROGRESS {
                    // Non-blocking connect (may occur on some kernel configs)
                    let mut pfd = libc::pollfd {
                        fd: sock,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    let poll_ret = libc::poll(&mut pfd, 1, 15000);
                    if poll_ret <= 0 {
                        libc::close(sock);
                        return Err(Error::Other("LE connect timeout".into()));
                    }
                    let mut so_err: i32 = 0;
                    let mut len: u32 = 4;
                    libc::getsockopt(
                        sock,
                        libc::SOL_SOCKET,
                        libc::SO_ERROR,
                        &mut so_err as *mut i32 as *mut libc::c_void,
                        &mut len,
                    );
                    if so_err != 0 {
                        libc::close(sock);
                        return Err(Error::Other(
                            format!(
                                "LE connect failed: {}",
                                std::io::Error::from_raw_os_error(so_err)
                            )
                            .into(),
                        ));
                    }
                } else {
                    let err = std::io::Error::last_os_error();
                    libc::close(sock);
                    return Err(Error::Other(format!("LE connect failed: {}", err).into()));
                }
            }

            sock
        };

        let mut conn = Self {
            sock,
            mtu: 23, // default ATT MTU
            services: Vec::new(),
            characteristics: Vec::new(),
            handle_map: HashMap::new(),
        };

        // Handle initial handshake (MTU exchange, server requests)
        conn.handle_initial_handshake();

        Ok(conn)
    }

    fn send(&self, data: &[u8]) -> Result<()> {
        unsafe {
            let ret = libc::send(self.sock, data.as_ptr() as *const libc::c_void, data.len(), 0);
            if ret < 0 {
                return Err(Error::Other(
                    format!("ATT send failed: {}", std::io::Error::last_os_error()).into(),
                ));
            }
        }
        Ok(())
    }

    fn recv(&self, timeout_ms: i32) -> Vec<u8> {
        let mut buf = [0u8; 517];
        unsafe {
            let mut pfd = libc::pollfd {
                fd: self.sock,
                events: libc::POLLIN,
                revents: 0,
            };
            let poll_ret = libc::poll(&mut pfd, 1, timeout_ms);
            if poll_ret <= 0 {
                return vec![];
            }
            let n = libc::recv(self.sock, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0);
            if n <= 0 {
                // n == 0: peer disconnected, n < 0: error
                return vec![];
            }
            buf[..n as usize].to_vec()
        }
    }

    /// Drain any pending server-initiated ATT requests from the socket.
    fn drain_server_requests(&self) {
        loop {
            let pkt = self.recv(100);
            if pkt.is_empty() {
                break;
            }
            let opcode = pkt[0];
            if opcode == ATT_OP_READ_BY_TYPE_REQ
                || opcode == ATT_OP_READ_BY_GROUP_TYPE_REQ
                || opcode == 0x04 // Find Information
                || opcode == 0x06 // Find By Type Value
            {
                let handle = if pkt.len() >= 3 {
                    u16::from_le_bytes([pkt[1], pkt[2]])
                } else {
                    0
                };
                let err_resp = vec![
                    ATT_OP_ERROR_RSP,
                    opcode,
                    handle as u8,
                    (handle >> 8) as u8,
                    ATT_ERR_ATTR_NOT_FOUND,
                ];
                let _ = self.send(&err_resp);
            } else {
                break;
            }
        }
    }

    /// Send an ATT request and receive the response, handling interleaved server requests.
    fn request(&self, req: &[u8], timeout_ms: i32) -> Result<Vec<u8>> {
        self.drain_server_requests();
        self.send(req)?;
        // Read responses, rejecting any server-initiated requests
        for _ in 0..10 {
            let resp = self.recv(timeout_ms);
            if resp.is_empty() {
                return Err(Error::Other("ATT request timeout".into()));
            }
            let opcode = resp[0];
            // Server-initiated requests: reject with Attribute Not Found
            if opcode == ATT_OP_READ_BY_TYPE_REQ
                || opcode == ATT_OP_READ_BY_GROUP_TYPE_REQ
                || opcode == 0x04 // Find Information
                || opcode == 0x06 // Find By Type Value
            {
                let handle = if resp.len() >= 3 {
                    u16::from_le_bytes([resp[1], resp[2]])
                } else {
                    0
                };
                let err_resp = vec![
                    ATT_OP_ERROR_RSP,
                    opcode,
                    handle as u8,
                    (handle >> 8) as u8,
                    ATT_ERR_ATTR_NOT_FOUND,
                ];
                let _ = self.send(&err_resp);
                continue;
            }
            return Ok(resp);
        }
        Err(Error::Other("Too many server requests during ATT operation".into()))
    }

    fn handle_initial_handshake(&mut self) {
        // Wait briefly for server-initiated packets
        let initial = self.recv(2000);
        if initial.is_empty() {
            return;
        }

        if initial[0] == ATT_OP_MTU_REQ && initial.len() >= 3 {
            let server_mtu = u16::from_le_bytes([initial[1], initial[2]]);
            let our_mtu: u16 = 517;
            let mut resp = vec![ATT_OP_MTU_RSP];
            resp.extend_from_slice(&our_mtu.to_le_bytes());
            let _ = self.send(&resp);
            // Effective MTU is the minimum of both (BT Core Spec Vol 3 Part F 3.4.2.2)
            self.mtu = server_mtu.min(our_mtu);
        }

        // Drain any remaining server-initiated requests
        self.drain_server_requests();
    }

    /// Discover all primary GATT services and their characteristics.
    pub fn discover_services(&mut self) -> Result<()> {
        self.services.clear();
        self.characteristics.clear();
        self.handle_map.clear();

        // Discover primary services
        let mut start: u16 = 0x0001;
        loop {
            let mut req = vec![ATT_OP_READ_BY_GROUP_TYPE_REQ];
            req.extend_from_slice(&start.to_le_bytes());
            req.extend_from_slice(&0xFFFFu16.to_le_bytes());
            req.extend_from_slice(&0x2800u16.to_le_bytes());

            let resp = self.request(&req, 5000)?;
            if resp[0] == ATT_OP_ERROR_RSP {
                break;
            }
            if resp[0] != ATT_OP_READ_BY_GROUP_TYPE_RSP || resp.len() < 2 {
                break;
            }

            let attr_len = resp[1] as usize;
            let mut offset = 2;
            while offset + attr_len <= resp.len() {
                let sh = u16::from_le_bytes([resp[offset], resp[offset + 1]]);
                let eh = u16::from_le_bytes([resp[offset + 2], resp[offset + 3]]);
                let uuid_bytes = &resp[offset + 4..offset + attr_len];
                let uuid = bytes_to_uuid(uuid_bytes);
                self.services.push(AttService {
                    uuid,
                    start_handle: sh,
                    end_handle: eh,
                });
                offset += attr_len;
                start = eh + 1;
            }

            if start == 0 || start > 0xFFFF - 1 {
                break;
            }
        }

        // Discover characteristics for each service
        for svc in self.services.clone() {
            let mut ch_start = svc.start_handle;
            loop {
                if ch_start > svc.end_handle {
                    break;
                }
                let mut req = vec![ATT_OP_READ_BY_TYPE_REQ];
                req.extend_from_slice(&ch_start.to_le_bytes());
                req.extend_from_slice(&svc.end_handle.to_le_bytes());
                req.extend_from_slice(&0x2803u16.to_le_bytes());

                let resp = self.request(&req, 5000)?;
                if resp[0] == ATT_OP_ERROR_RSP {
                    break;
                }
                if resp[0] != ATT_OP_READ_BY_TYPE_RSP || resp.len() < 2 {
                    break;
                }

                let attr_len = resp[1] as usize;
                let mut offset = 2;
                while offset + attr_len <= resp.len() {
                    let handle = u16::from_le_bytes([resp[offset], resp[offset + 1]]);
                    let props = resp[offset + 2];
                    let value_handle = u16::from_le_bytes([resp[offset + 3], resp[offset + 4]]);
                    let uuid_bytes = &resp[offset + 5..offset + attr_len];
                    let uuid = bytes_to_uuid(uuid_bytes);

                    self.characteristics.push(AttCharacteristic {
                        uuid,
                        _handle: handle,
                        value_handle,
                        properties: props,
                    });
                    self.handle_map.insert((svc.uuid, uuid), value_handle);

                    offset += attr_len;
                    ch_start = handle + 1;
                }
            }
        }

        Ok(())
    }

    pub fn get_services(&self) -> &[AttService] {
        &self.services
    }

    pub fn get_characteristics(&self) -> &[AttCharacteristic] {
        &self.characteristics
    }

    /// Read a characteristic by its value handle.
    pub fn read_by_handle(&self, handle: u16) -> Result<Vec<u8>> {
        let mut req = vec![ATT_OP_READ_REQ];
        req.extend_from_slice(&handle.to_le_bytes());
        let resp = self.request(&req, 5000)?;
        if resp[0] == ATT_OP_READ_RSP {
            Ok(resp[1..].to_vec())
        } else if resp[0] == ATT_OP_ERROR_RSP {
            Err(Error::Other(
                format!("ATT read error: {:#04x}", resp.get(4).copied().unwrap_or(0)).into(),
            ))
        } else {
            Err(Error::Other(format!("Unexpected ATT response: {:#04x}", resp[0]).into()))
        }
    }

    /// Write to a characteristic (with response).
    pub fn write_by_handle(&self, handle: u16, data: &[u8]) -> Result<()> {
        let mut req = vec![ATT_OP_WRITE_REQ];
        req.extend_from_slice(&handle.to_le_bytes());
        req.extend_from_slice(data);
        let resp = self.request(&req, 5000)?;
        if resp[0] == ATT_OP_WRITE_RSP {
            Ok(())
        } else if resp[0] == ATT_OP_ERROR_RSP {
            Err(Error::Other(
                format!("ATT write error: {:#04x}", resp.get(4).copied().unwrap_or(0)).into(),
            ))
        } else {
            Err(Error::Other(format!("Unexpected ATT response: {:#04x}", resp[0]).into()))
        }
    }

    /// Write to a characteristic (without response / command).
    pub fn write_cmd_by_handle(&self, handle: u16, data: &[u8]) -> Result<()> {
        let mut req = vec![ATT_OP_WRITE_CMD];
        req.extend_from_slice(&handle.to_le_bytes());
        req.extend_from_slice(data);
        self.send(&req)
    }

    /// Look up the ATT handle for a (service_uuid, characteristic_uuid) pair.
    pub fn get_handle(&self, service_uuid: &Uuid, char_uuid: &Uuid) -> Option<u16> {
        self.handle_map.get(&(*service_uuid, *char_uuid)).copied()
    }

    /// Check if the socket is still connected.
    pub fn is_connected(&self) -> bool {
        if self.sock < 0 {
            return false;
        }
        unsafe {
            let mut pfd = libc::pollfd {
                fd: self.sock,
                events: libc::POLLERR | libc::POLLHUP,
                revents: 0,
            };
            let ret = libc::poll(&mut pfd, 1, 0);
            if ret > 0 && (pfd.revents & (libc::POLLERR | libc::POLLHUP)) != 0 {
                return false;
            }
            true
        }
    }

    pub fn close(&mut self) {
        if self.sock >= 0 {
            unsafe {
                libc::close(self.sock);
            }
            self.sock = -1;
        }
    }
}

impl Drop for RawAttConnection {
    fn drop(&mut self) {
        self.close();
    }
}

fn bytes_to_uuid(bytes: &[u8]) -> Uuid {
    if bytes.len() == 2 {
        // 16-bit UUID -> full 128-bit Bluetooth Base UUID
        let short = u16::from_le_bytes([bytes[0], bytes[1]]);
        let full = format!("0000{:04x}-0000-1000-8000-00805f9b34fb", short);
        full.parse().unwrap()
    } else if bytes.len() == 16 {
        // 128-bit UUID in little-endian
        let mut be = [0u8; 16];
        for i in 0..16 {
            be[i] = bytes[15 - i];
        }
        Uuid::from_bytes(be)
    } else {
        Uuid::nil()
    }
}
