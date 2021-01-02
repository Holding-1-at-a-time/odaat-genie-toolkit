#!/bin/sh

podir=`dirname $0`
mkdir -p $podir/tmp
for f in $podir/../data/builtins/*/manifest.tt ; do
	kind=$(basename $(dirname $f))
	ts-node $podir/extract-translatable-annotations $f > $podir/tmp/$kind.js
done
find lib -name \*.js -or -name \*.ts > po/POTFILES
xgettext -kN_ -c -f po/POTFILES -x po/POTFILES.skip -LJavaScript -o po/${npm_package_name}.pot --from-code UTF-8 --package-name ${npm_package_name} --package-version ${npm_package_version}
