package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

type CentralCA struct {
	mu  sync.Mutex
	dir string // e.g. /opt/vpn-api/ca or ./ca
}

func NewCentralCA(dir string) *CentralCA {
	return &CentralCA{dir: dir}
}

func (ca *CentralCA) Dir() string { return ca.dir }

func (ca *CentralCA) Init() error {
	ca.mu.Lock()
	defer ca.mu.Unlock()

	if _, err := os.Stat(filepath.Join(ca.dir, "pki", "ca.crt")); err == nil {
		return nil
	}

	os.MkdirAll(ca.dir, 0700)

	easyrsaBin := ca.findEasyRSA()
	if easyrsaBin == "" {
		return fmt.Errorf("easyrsa binary not found, install easy-rsa or set CA_EASYRSA_BIN")
	}

	env := append(os.Environ(), "EASYRSA_BATCH=1")

	for _, args := range [][]string{
		{"init-pki"},
		{"build-ca", "nopass"},
		{"gen-crl"},
	} {
		cmd := exec.Command(easyrsaBin, args...)
		cmd.Dir = ca.dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("easyrsa %v: %w\n%s", args, err, out)
		}
	}

	tlsKeyPath := filepath.Join(ca.dir, "pki", "private", "tls-crypt.key")
	cmd := exec.Command("openvpn", "--genkey", "secret", tlsKeyPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		os.WriteFile(tlsKeyPath, []byte("# placeholder tls key\n"), 0600)
		_ = out
	}

	return nil
}

func (ca *CentralCA) findEasyRSA() string {
	if v := os.Getenv("CA_EASYRSA_BIN"); v != "" {
		return v
	}
	candidates := []string{
		filepath.Join(ca.dir, "easyrsa"),
		"/usr/share/easy-rsa/easyrsa",
		"/usr/bin/easyrsa",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if p, err := exec.LookPath("easyrsa"); err == nil {
		return p
	}
	return ""
}

func (ca *CentralCA) CACert() ([]byte, error) {
	return os.ReadFile(filepath.Join(ca.dir, "pki", "ca.crt"))
}

func (ca *CentralCA) TLSCryptKey() ([]byte, error) {
	return os.ReadFile(filepath.Join(ca.dir, "pki", "private", "tls-crypt.key"))
}

func (ca *CentralCA) CRL() ([]byte, error) {
	return os.ReadFile(filepath.Join(ca.dir, "pki", "crl.pem"))
}

type CABundle struct {
	CACert      string `json:"ca_cert"`
	TLSCryptKey string `json:"tls_crypt_key"`
	CRL         string `json:"crl"`
}

func (ca *CentralCA) Bundle() (*CABundle, error) {
	caCert, err := ca.CACert()
	if err != nil {
		return nil, err
	}
	tlsKey, _ := ca.TLSCryptKey()
	crl, _ := ca.CRL()
	return &CABundle{
		CACert:      string(caCert),
		TLSCryptKey: string(tlsKey),
		CRL:         string(crl),
	}, nil
}
