package engine

import (
	"fmt"

	"github.com/keybase/client/go/libkb"
)

type DeviceKeygenArgs struct {
	Me         *libkb.User
	DeviceID   libkb.DeviceID
	DeviceName string
	Lks        *libkb.LKSec
}

// DeviceKeygenPushArgs determines how the push will run.  There are
// currently three different paths it can take:
//
// 1. this device is the eldest device:  pushes eldest signing
// key, encryption subkey. (IsEldest => true)
//
// 2. this device is a sibling (but we're not in a key exchange
// scenario):  pushes sibkey signing key, encryption subkey.
// (IsEldest => False, SkipSignerPush => false, Signer != nil,
// EldestKID != nil)
//
// 3. this device is a sibling, but another device pushed
// the signing key, so skip that part.
// (IsEldest => False, SkipSignerPush => true, Signer != nil,
// EldestKID != nil)
//
// The User argument is optional, but it is necessary if the
// user's sigchain changes between key generation and key push.
//
type DeviceKeygenPushArgs struct {
	IsEldest       bool
	SkipSignerPush bool
	Signer         libkb.GenericKey
	EldestKID      libkb.KID
	User           *libkb.User // optional
}

type DeviceKeygen struct {
	args *DeviceKeygenArgs

	runErr  error
	pushErr error

	naclSignGen *libkb.NaclKeyGen
	naclEncGen  *libkb.NaclKeyGen

	libkb.Contextified
}

// NewDeviceKeygen creates a DeviceKeygen engine.
func NewDeviceKeygen(args *DeviceKeygenArgs, g *libkb.GlobalContext) *DeviceKeygen {
	return &DeviceKeygen{
		args:         args,
		Contextified: libkb.NewContextified(g),
	}
}

// Name is the unique engine name.
func (e *DeviceKeygen) Name() string {
	return "DeviceKeygen"
}

// GetPrereqs returns the engine prereqs.
func (e *DeviceKeygen) Prereqs() Prereqs {
	return Prereqs{Session: true}
}

// RequiredUIs returns the required UIs.
func (e *DeviceKeygen) RequiredUIs() []libkb.UIKind {
	return []libkb.UIKind{
		libkb.LogUIKind,
	}
}

// SubConsumers returns the other UI consumers for this engine.
func (e *DeviceKeygen) SubConsumers() []libkb.UIConsumer {
	return nil
}

// Run starts the engine.
func (e *DeviceKeygen) Run(ctx *Context) error {
	e.setup(ctx)
	e.generate()
	e.localSave(ctx)
	return e.runErr
}

func (e *DeviceKeygen) SigningKeyPublic() (libkb.NaclSigningKeyPublic, error) {
	s, ok := e.naclSignGen.GetKeyPair().(libkb.NaclSigningKeyPair)
	if !ok {
		return libkb.NaclSigningKeyPublic{}, libkb.BadKeyError{Msg: fmt.Sprintf("invalid key type %T", e.naclSignGen.GetKeyPair())}
	}
	return s.Public, nil

}

func (e *DeviceKeygen) SigningKey() libkb.NaclKeyPair {
	return e.naclSignGen.GetKeyPair()
}

// Push pushes the generated keys to the api server and stores the
// local key security server half on the api server as well.
func (e *DeviceKeygen) Push(ctx *Context, pargs *DeviceKeygenPushArgs) error {
	var encSigner libkb.GenericKey
	eldestKID := pargs.EldestKID

	// push the signing key
	if pargs.IsEldest {
		e.pushEldest(ctx, pargs)
		encSigner = e.naclSignGen.GetKeyPair()
		eldestKID = encSigner.GetKid()
	} else if !pargs.SkipSignerPush {
		e.pushSibkey(ctx, pargs)
		encSigner = e.naclSignGen.GetKeyPair()
	} else {
		encSigner = pargs.Signer
	}

	// push the encryption key
	e.pushEncKey(ctx, encSigner, eldestKID, pargs.User)

	// push the LKS server half
	e.pushLKS(ctx)

	return e.pushErr
}

func (e *DeviceKeygen) setup(ctx *Context) {
	if e.runErr != nil {
		return
	}

	signArg := e.newNaclArg(ctx, func() (libkb.NaclKeyPair, error) {
		kp, err := libkb.GenerateNaclSigningKeyPair()
		if err != nil {
			return nil, err
		}
		return kp, nil
	}, libkb.NaclEdDSAExpireIn)
	e.naclSignGen = libkb.NewNaclKeyGen(signArg)

	encArg := e.newNaclArg(ctx, func() (libkb.NaclKeyPair, error) {
		kp, err := libkb.GenerateNaclDHKeyPair()
		if err != nil {
			return nil, err
		}
		return kp, nil
	}, libkb.NaclDHExpireIn)
	e.naclEncGen = libkb.NewNaclKeyGen(encArg)
}

func (e *DeviceKeygen) generate() {
	if e.runErr != nil {
		return
	}

	if e.runErr = e.naclSignGen.Generate(); e.runErr != nil {
		return
	}

	if e.runErr = e.naclEncGen.Generate(); e.runErr != nil {
		return
	}
}

func (e *DeviceKeygen) localSave(ctx *Context) {
	if e.runErr != nil {
		return
	}

	if e.runErr = e.naclSignGen.SaveLKS(e.args.Lks, ctx.LoginContext); e.runErr != nil {
		return
	}
	if e.runErr = e.naclEncGen.SaveLKS(e.args.Lks, ctx.LoginContext); e.runErr != nil {
		return
	}
}

func (e *DeviceKeygen) pushEldest(ctx *Context, pargs *DeviceKeygenPushArgs) {
	if e.pushErr != nil {
		return
	}
	_, e.pushErr = e.naclSignGen.Push(ctx.LoginContext)
}

func (e *DeviceKeygen) pushSibkey(ctx *Context, pargs *DeviceKeygenPushArgs) {
	if e.pushErr != nil {
		return
	}

	e.naclSignGen.UpdateArg(pargs.Signer, pargs.EldestKID, true, pargs.User)
	_, e.pushErr = e.naclSignGen.Push(ctx.LoginContext)
}

func (e *DeviceKeygen) pushEncKey(ctx *Context, signer libkb.GenericKey, eldestKID libkb.KID, user *libkb.User) {
	if e.pushErr != nil {
		return
	}
	e.naclEncGen.UpdateArg(signer, eldestKID, false, user)
	_, e.pushErr = e.naclEncGen.Push(ctx.LoginContext)
}

func (e *DeviceKeygen) generateClientHalfRecovery() (string, libkb.KID, error) {
	key := e.naclEncGen.GetKeyPair()
	kid := key.GetKid()
	ctext, err := e.args.Lks.EncryptClientHalfRecovery(key)
	return ctext, kid, err
}

func (e *DeviceKeygen) pushLKS(ctx *Context) {
	if e.pushErr != nil {
		return
	}

	if e.args.Lks == nil {
		e.pushErr = fmt.Errorf("no local key security set")
		return
	}

	serverHalf := e.args.Lks.GetServerHalf()
	if len(serverHalf) == 0 {
		e.pushErr = fmt.Errorf("LKS server half is empty, and should not be")
		return
	}

	var chr string
	var chrk libkb.KID
	if chr, chrk, e.pushErr = e.generateClientHalfRecovery(); e.pushErr != nil {
		return
	}

	// send it to api server
	e.pushErr = libkb.PostDeviceLKS(ctx.LoginContext, e.args.DeviceID.String(), libkb.DeviceTypeDesktop, serverHalf, e.args.Lks.Generation(), chr, chrk)
	if e.pushErr != nil {
		return
	}

	// Sync the LKS stuff back from the server, so that subsequent
	// attempts to use public key login will work.
	if ctx.LoginContext != nil {
		e.pushErr = ctx.LoginContext.RunSecretSyncer(e.args.Me.GetUID())
	} else {
		e.pushErr = e.G().LoginState().RunSecretSyncer(e.args.Me.GetUID())
	}
}

func (e *DeviceKeygen) newNaclArg(ctx *Context, gen libkb.NaclGenerator, expire int) libkb.NaclKeyGenArg {
	return libkb.NaclKeyGenArg{
		Generator: gen,
		Device:    e.device(),
		Me:        e.args.Me,
		ExpireIn:  expire,
		LogUI:     ctx.LogUI,
	}
}

func (e *DeviceKeygen) device() *libkb.Device {
	s := libkb.DeviceStatusActive
	return &libkb.Device{
		ID:          e.args.DeviceID.String(),
		Description: &e.args.DeviceName,
		Type:        libkb.DeviceTypeDesktop,
		Status:      &s,
	}
}
